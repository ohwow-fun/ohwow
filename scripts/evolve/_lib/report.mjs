/**
 * Run reporting for the self-evolution system.
 * Writes JSON run reports and appends to the JSONL ledger.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const REPORTS_DIR = path.join(os.homedir(), '.ohwow', 'evolution-reports');
const LEDGER_PATH = path.join(REPORTS_DIR, 'evolution-ledger.jsonl');

export function ensureReportsDir() {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

/**
 * Write a full JSON report for a run, and append a summary line to the ledger.
 * Returns { runId, filePath }.
 */
export function writeRunReport(report) {
  ensureReportsDir();

  const runId = `run-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  const filePath = path.join(REPORTS_DIR, `${runId}.json`);

  // Full report: everything
  fs.writeFileSync(filePath, JSON.stringify({ runId, ...report }, null, 2));

  // Ledger entry: compact summary for history scanning
  const entry = {
    runId,
    taskId: report.task?.taskId ?? null,
    status: report.status,
    timestamp: new Date().toISOString(),
    repo: report.task?.targetRepo ?? null,
    filesChanged: report.filesChanged?.length ?? 0,
    commit: report.commit?.hash ?? null,
  };
  fs.appendFileSync(LEDGER_PATH, JSON.stringify(entry) + '\n');

  return { runId, filePath };
}
