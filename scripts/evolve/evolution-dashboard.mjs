#!/usr/bin/env node
/**
 * Evolution dashboard — reads all run reports and prints a summary.
 * Also writes ~/.ohwow/evolution-reports/SUMMARY.md for easy reading.
 * Usage: node scripts/evolve/evolution-dashboard.mjs
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

const REPORTS_DIR = path.join(os.homedir(), '.ohwow', 'evolution-reports');
const LEDGER = path.join(REPORTS_DIR, 'evolution-ledger.jsonl');

function loadLedger() {
  if (!fs.existsSync(LEDGER)) return [];
  return fs.readFileSync(LEDGER, 'utf8')
    .split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function loadRunReports() {
  if (!fs.existsSync(REPORTS_DIR)) return [];
  return fs.readdirSync(REPORTS_DIR)
    .filter(f => f.startsWith('run-') && f.endsWith('.json'))
    .sort()
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, f), 'utf8')); }
      catch { return null; }
    })
    .filter(Boolean);
}

function formatDuration(ms) {
  if (!ms) return 'n/a';
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

async function main() {
  const ledger = loadLedger();
  const reports = loadRunReports();

  const successful = ledger.filter(e => e.status === 'success');
  const failed = ledger.filter(e => e.status === 'failed');
  const errors = ledger.filter(e => e.status === 'error');
  const noops = ledger.filter(e => e.status === 'noop');

  // Group by repo
  const byRepo = {};
  for (const e of ledger) {
    const repo = e.repo ? path.basename(e.repo) : 'unknown';
    byRepo[repo] = byRepo[repo] || [];
    byRepo[repo].push(e);
  }

  // Build markdown
  const lines = [
    `# ohwow Self-Evolution Dashboard`,
    ``,
    `**Generated:** ${new Date().toISOString()}`,
    ``,
    `## Summary`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Total cycles run | ${ledger.length} |`,
    `| Successful commits | ${successful.length} |`,
    `| Failed (reverted) | ${failed.length} |`,
    `| Errors | ${errors.length} |`,
    `| No-ops (nothing to do) | ${noops.length} |`,
    `| Repos touched | ${Object.keys(byRepo).join(', ')} |`,
    ``,
    `## Successful Commits`,
    ``,
    `| Timestamp | Task | Repo | Commit | Files |`,
    `|-----------|------|------|--------|-------|`,
    ...successful.map(e =>
      `| ${e.timestamp?.slice(0, 16)} | ${e.taskId} | ${path.basename(e.repo || '')} | \`${e.commit || 'n/a'}\` | ${e.filesChanged || 0} |`
    ),
    ``,
    `## Failed Cycles`,
    ``,
    ...(failed.length === 0
      ? [`*None*`]
      : failed.map(e =>
          `- **${e.taskId}** (${e.timestamp?.slice(0, 16)}): reverted`
        )),
    ``,
    `## Errors`,
    ``,
    ...(errors.length === 0
      ? [`*None*`]
      : errors.map(e =>
          `- **${e.taskId}** (${e.timestamp?.slice(0, 16)}): ${e.repo ? path.basename(e.repo) : 'unknown'}`
        )),
    ``,
    `## Recent Run Details`,
    ``,
    ...reports.slice(-3).flatMap(r => [
      `### ${r.runId}`,
      `- **Task:** ${r.task?.title || 'n/a'}`,
      `- **Status:** ${r.status}`,
      `- **Duration:** ${formatDuration(r.execution?.durationMs)}`,
      `- **Files changed:** ${(r.filesChanged || []).join(', ') || 'none'}`,
      `- **Commit:** \`${r.commit?.hash || 'none'}\``,
      `- **Summary:** ${r.summary?.slice(0, 200) || 'n/a'}`,
      ``,
    ]),
  ];

  const markdown = lines.join('\n');

  // Write SUMMARY.md
  fs.writeFileSync(path.join(REPORTS_DIR, 'SUMMARY.md'), markdown);

  // Print to console
  console.log(markdown);
  console.log(`\nSUMMARY.md written to ${path.join(REPORTS_DIR, 'SUMMARY.md')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
