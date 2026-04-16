/**
 * One-shot recovery for KB documents that DocumentWorker wrongly
 * rejected with "No text could be extracted." while the worker
 * lacked a fallback branch for source_types like 'arxiv' and
 * 'self-observation'. After the fix landed the queue needs a nudge:
 * reset processing_status → 'processing', insert fresh queue rows
 * pointed at the affected documents, and the worker drains them
 * next tick.
 *
 * Safe to re-run. Only touches rows where:
 *   - compiled_text IS NOT NULL AND length > 0
 *   - processing_status IN ('failed','processing')  (not 'ready')
 *   - source_type in the allowlist (arxiv, self-observation)
 *
 * Run: npx tsx scripts/reenqueue-failed-kb-docs.ts [--workspace=default] [--dry-run]
 */

import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { workspaceLayoutFor } from '../src/config.js';

interface Args {
  workspace: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? null;
  return {
    workspace: get('workspace') ?? 'default',
    dryRun: argv.includes('--dry-run'),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const layout = workspaceLayoutFor(args.workspace);
  const db = new Database(layout.dbPath);
  try {
    const rows = db
      .prepare(
        `SELECT id, workspace_id, source_type, source_url, title
         FROM agent_workforce_knowledge_documents
         WHERE source_type IN ('arxiv','self-observation')
           AND processing_status IN ('failed','processing')
           AND compiled_text IS NOT NULL
           AND LENGTH(compiled_text) > 0`,
      )
      .all() as Array<{ id: string; workspace_id: string; source_type: string; source_url: string; title: string }>;

    process.stdout.write(`[reenqueue] found ${rows.length} doc(s) to recover\n`);
    for (const r of rows) {
      process.stdout.write(`  - ${r.id.slice(0, 8)} [${r.source_type}] ${r.title.slice(0, 70)}\n`);
    }
    if (args.dryRun) {
      process.stdout.write('[reenqueue] --dry-run: no writes\n');
      return;
    }
    if (rows.length === 0) return;

    const updateDoc = db.prepare(
      `UPDATE agent_workforce_knowledge_documents
       SET processing_status='processing'
       WHERE id=?`,
    );
    const insertJob = db.prepare(
      `INSERT INTO document_processing_queue
         (id, workspace_id, document_id, status, payload)
       VALUES (?, ?, ?, 'pending', ?)`,
    );
    const tx = db.transaction(() => {
      for (const r of rows) {
        updateDoc.run(r.id);
        const jobId = createHash('sha256')
          .update(`reenqueue-${Date.now()}-${r.id}`)
          .digest('hex')
          .slice(0, 32);
        const payload = JSON.stringify({ source_type: r.source_type, url: r.source_url });
        insertJob.run(jobId, r.workspace_id, r.id, payload);
      }
    });
    tx();
    process.stdout.write(`[reenqueue] requeued ${rows.length} doc(s). Worker will drain on next tick.\n`);
  } finally {
    db.close();
  }
}

main().catch((err) => {
  process.stderr.write(
    `[reenqueue] failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});
