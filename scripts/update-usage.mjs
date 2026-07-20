// Regenerates the AI-usage section of README.md between the
// <!-- usage:start --> / <!-- usage:end --> markers from the usage_daily
// Postgres table. Connection string comes from DATABASE_URL, falling back to
// ~/.claude/usage-sync.json (same config the collector uses) for local runs.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const README = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'README.md');
const START = '<!-- usage:start -->';
const END = '<!-- usage:end -->';

const AGENT_LABELS = {
  anthropic: '🟠 Claude Code (Anthropic)',
  openai: '⚪ Codex CLI (OpenAI)',
  google: '🔵 Antigravity (Google)',
};

function connectionString() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const cfg = path.join(homedir(), '.claude', 'usage-sync.json');
  if (existsSync(cfg)) return JSON.parse(readFileSync(cfg, 'utf8')).databaseUrl;
  throw new Error('no DATABASE_URL and no ~/.claude/usage-sync.json');
}

function compact(n) {
  n = Number(n);
  if (n >= 995e7) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return String(n);
}

function monthYear(day) {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  });
}

const client = new pg.Client({ connectionString: connectionString() });
await client.connect();

const { rows: providers } = await client.query(`
  SELECT provider,
         SUM(input_tokens) input, SUM(output_tokens) output,
         SUM(cache_read_tokens) cache_read, SUM(cache_creation_tokens) cache_creation,
         SUM(requests) requests, MIN(day) first_day
  FROM usage_daily WHERE source = 'ingest'
  GROUP BY provider ORDER BY SUM(output_tokens) DESC`);

const { rows: models } = await client.query(`
  SELECT model, SUM(output_tokens) output, SUM(requests) requests
  FROM usage_daily WHERE source = 'ingest'
  GROUP BY model HAVING SUM(output_tokens) >= 100000
  ORDER BY SUM(output_tokens) DESC LIMIT 10`);

const { rows: days } = await client.query(`
  SELECT day, SUM(input_tokens + output_tokens) tokens
  FROM usage_daily WHERE source = 'ingest' AND day::date > CURRENT_DATE - 30
  GROUP BY day ORDER BY day`);

const { rows: [{ n: modelCount }] } = await client.query(
  `SELECT COUNT(DISTINCT model) n FROM usage_daily WHERE source = 'ingest'`);

await client.end();

const sum = (col) => providers.reduce((a, r) => a + Number(r[col]), 0);
const grandTotal = sum('input') + sum('output') + sum('cache_read') + sum('cache_creation');
const firstDay = providers.map((r) => r.first_day).sort()[0];

// sparkline over the trailing 30 calendar days, missing days = 0
const byDay = new Map(days.map((r) => [r.day, Number(r.tokens)]));
const today = new Date();
const series = Array.from({ length: 30 }, (_, i) => {
  const d = new Date(today);
  d.setUTCDate(d.getUTCDate() - (29 - i));
  const key = d.toISOString().slice(0, 10);
  return { day: key, tokens: byDay.get(key) ?? 0 };
});
const max = Math.max(...series.map((s) => s.tokens), 1);
const BLOCKS = '▁▂▃▄▅▆▇█';
const spark = series
  .map((s) => BLOCKS[Math.min(7, Math.floor((s.tokens / max) * 8))])
  .join('');
const peak = series.reduce((a, b) => (b.tokens > a.tokens ? b : a));
const peakLabel = new Date(`${peak.day}T00:00:00Z`).toLocaleDateString('en-US', {
  month: 'short', day: 'numeric', timeZone: 'UTC',
});

const section = `${START}
### 🤖 My AI usage, measured

Every token my AI coding agents burn is metered — Claude Code, Codex CLI, and Antigravity session logs sync to Postgres via a small usage-collector script, and a nightly Action rebuilds this section from the database.

**${compact(grandTotal)} tokens processed** · **${sum('requests').toLocaleString('en-US')} requests** · **${modelCount} models** · since ${monthYear(firstDay)}

| Agent | Requests | Input | Output | Cache reads |
|---|--:|--:|--:|--:|
${providers
  .map((r) => `| ${AGENT_LABELS[r.provider] ?? r.provider} | ${Number(r.requests).toLocaleString('en-US')} | ${compact(r.input)} | ${compact(r.output)} | ${compact(r.cache_read)} |`)
  .join('\n')}

<details>
<summary><b>Top models by output tokens</b></summary>

| Model | Output | Requests |
|---|--:|--:|
${models
  .map((r) => `| ${r.model} | ${compact(r.output)} | ${Number(r.requests).toLocaleString('en-US')} |`)
  .join('\n')}

</details>

**Last 30 days** — tokens/day, peak ${compact(peak.tokens)} on ${peakLabel}

\`\`\`text
${spark}
\`\`\`

<sub>Updated ${new Date().toISOString().slice(0, 10)} · input/output exclude cache reads</sub>
${END}`;

const readme = readFileSync(README, 'utf8');
const pattern = new RegExp(`${START}[\\s\\S]*?${END}`);
if (!pattern.test(readme)) throw new Error('usage markers not found in README.md');
writeFileSync(README, readme.replace(pattern, section));
console.log('README.md usage section updated');
