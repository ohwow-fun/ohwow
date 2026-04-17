/* eslint-disable no-console */
/**
 * `ohwow revenue` — manual revenue ingest for the self-improvement loop.
 *
 * The loop's credit-assignment phase needs a real outcome signal. The
 * Stripe webhook handles automated ingest; this CLI is the manual lane
 * for early-stage revenue (invoices, cash, one-off deals) and for
 * operator corrections. Writes directly to agent_workforce_revenue_entries
 * so RevenuePulse and the KPI registry see it on the next pulse.
 *
 * Subcommands:
 *   add <cents> [--contact <id>] [--source <s>] [--note <n>]
 *       [--month <1-12>] [--year <yyyy>]
 *   list [--limit <n>]
 *
 * Month/year default to today (UTC). Amount is cents (integer).
 */

import crypto from 'node:crypto';

interface AddArgs {
  amount_cents: number;
  contact_id?: string;
  source?: string;
  notes?: string;
  month?: number;
  year?: number;
}

function parseIntStrict(s: string): number | null {
  if (!/^-?\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function takeFlag(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const withEq = args.find((a) => a.startsWith(prefix));
  if (withEq) return withEq.slice(prefix.length);
  const idx = args.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < args.length && !args[idx + 1].startsWith('--')) {
    return args[idx + 1];
  }
  return undefined;
}

export function parseAddArgs(args: string[]): { ok: true; args: AddArgs } | { ok: false; error: string } {
  const positional = args.filter((a) => !a.startsWith('--'));
  // Drop consumed-by-flag values. We re-walk via takeFlag below.
  const flags = {
    contact: takeFlag(args, 'contact'),
    source: takeFlag(args, 'source'),
    note: takeFlag(args, 'note'),
    month: takeFlag(args, 'month'),
    year: takeFlag(args, 'year'),
  };
  // After taking flags, filter out values that were consumed by a --flag <value> pair
  const flagValueSet = new Set([flags.contact, flags.source, flags.note, flags.month, flags.year].filter(Boolean) as string[]);
  const cleanPositional = positional.filter((p, i) => {
    // First positional is the amount; later ones might be leftover flag values
    if (i === 0) return true;
    return !flagValueSet.has(p);
  });
  if (cleanPositional.length < 1) {
    return { ok: false, error: 'amount (in cents) is required as the first argument' };
  }
  const amount = parseIntStrict(cleanPositional[0]);
  if (amount === null || amount <= 0) {
    return { ok: false, error: `amount must be a positive integer (cents); got "${cleanPositional[0]}"` };
  }
  const month = flags.month ? parseIntStrict(flags.month) : null;
  if (flags.month && (month === null || month < 1 || month > 12)) {
    return { ok: false, error: `--month must be 1-12; got "${flags.month}"` };
  }
  const year = flags.year ? parseIntStrict(flags.year) : null;
  if (flags.year && (year === null || year < 2000 || year > 2100)) {
    return { ok: false, error: `--year must be 2000-2100; got "${flags.year}"` };
  }
  return {
    ok: true,
    args: {
      amount_cents: amount,
      contact_id: flags.contact,
      source: flags.source,
      notes: flags.note,
      month: month ?? undefined,
      year: year ?? undefined,
    },
  };
}

function printHelp(): void {
  console.log('Usage:');
  console.log('  ohwow revenue add <cents> [flags]     Add a revenue entry');
  console.log('  ohwow revenue list [--limit <n>]      List recent revenue entries');
  console.log('');
  console.log('add flags:');
  console.log('  --contact <id>    Attribute to a contact (agent_workforce_contacts.id)');
  console.log('  --source <s>      Free-text source label (e.g. "stripe", "manual", "invoice")');
  console.log('  --note <n>        Free-text notes');
  console.log('  --month <1-12>    Override month (defaults to current UTC month)');
  console.log('  --year <yyyy>     Override year (defaults to current UTC year)');
  console.log('');
  console.log('Examples:');
  console.log('  ohwow revenue add 50000 --source manual --note "Acme Corp — Q2 retainer"');
  console.log('  ohwow revenue add 2500 --contact c_abc123 --source stripe');
  console.log('  ohwow revenue list --limit 20');
}

interface RevenueRow {
  id: string;
  amount_cents: number;
  month: number;
  year: number;
  source: string | null;
  notes: string | null;
  contact_id: string | null;
  created_at: string;
}

export async function runRevenueCli(args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    printHelp();
    process.exit(sub ? 0 : 1);
  }

  if (sub !== 'add' && sub !== 'list') {
    console.error(`Unknown revenue subcommand: ${sub}`);
    printHelp();
    process.exit(1);
  }

  // Lazy-load runtime deps so `ohwow revenue --help` doesn't touch the DB.
  const { loadConfig } = await import('../config.js');
  const { initDatabase } = await import('../db/init.js');
  const { createSqliteAdapter } = await import('../db/sqlite-adapter.js');

  const config = loadConfig();
  const rawDb = initDatabase(config.dbPath);
  const db = createSqliteAdapter(rawDb);

  // Resolve workspace row id positionally (honors consolidation — the
  // row's id may be 'local' or a cloud UUID, never hardcode either).
  const wsRow = rawDb
    .prepare('SELECT id FROM agent_workforce_workspaces LIMIT 1')
    .get() as { id: string } | undefined;
  if (!wsRow?.id) {
    console.error('No workspace row found. Run `ohwow` once to initialize the workspace.');
    process.exit(1);
  }
  const workspaceId = wsRow.id;

  if (sub === 'add') {
    const parsed = parseAddArgs(args.slice(1));
    if (!parsed.ok) {
      console.error(`Error: ${parsed.error}`);
      printHelp();
      process.exit(1);
    }
    const a = parsed.args;
    const now = new Date();
    const month = a.month ?? now.getUTCMonth() + 1;
    const year = a.year ?? now.getUTCFullYear();
    const id = crypto.randomUUID();
    const nowIso = now.toISOString();

    const { error } = await db.from('agent_workforce_revenue_entries').insert({
      id,
      workspace_id: workspaceId,
      amount_cents: a.amount_cents,
      month,
      year,
      source: a.source ?? null,
      notes: a.notes ?? null,
      contact_id: a.contact_id ?? null,
      created_at: nowIso,
      updated_at: nowIso,
    });
    if (error) {
      console.error(`Insert failed: ${error.message}`);
      process.exit(1);
    }

    // Readback: show MTD total so the operator sees the new aggregate.
    const { data: mtd } = await db
      .from<{ amount_cents: number }>('agent_workforce_revenue_entries')
      .select('amount_cents')
      .eq('workspace_id', workspaceId)
      .eq('month', month)
      .eq('year', year)
      .limit(10000);
    const mtdTotal = (mtd ?? []).reduce((acc, r) => acc + (Number(r.amount_cents) || 0), 0);

    console.log(`Added $${(a.amount_cents / 100).toFixed(2)} (id=${id.slice(0, 8)}).`);
    console.log(`MTD total for ${year}-${String(month).padStart(2, '0')}: $${(mtdTotal / 100).toFixed(2)}.`);
    if (a.contact_id) console.log(`Attributed to contact: ${a.contact_id}`);
    process.exit(0);
  }

  if (sub === 'list') {
    const limitArg = takeFlag(args, 'limit');
    const limit = limitArg ? parseIntStrict(limitArg) : 10;
    if (limit === null || limit <= 0 || limit > 500) {
      console.error('--limit must be a positive integer up to 500');
      process.exit(1);
    }
    const { data } = await db
      .from<RevenueRow>('agent_workforce_revenue_entries')
      .select('id,amount_cents,month,year,source,notes,contact_id,created_at')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false })
      .limit(limit);
    const rows = (data ?? []) as RevenueRow[];
    if (rows.length === 0) {
      console.log('No revenue entries yet.');
      console.log('Try: ohwow revenue add 50000 --source manual --note "First deal"');
      process.exit(0);
    }
    for (const r of rows) {
      const amount = `$${(r.amount_cents / 100).toFixed(2)}`.padStart(12);
      const when = r.created_at.slice(0, 10);
      const period = `${r.year}-${String(r.month).padStart(2, '0')}`;
      const src = r.source ?? '-';
      const contact = r.contact_id ? `contact=${r.contact_id.slice(0, 8)}` : '';
      console.log(`${when}  ${amount}  ${period}  src=${src}  ${contact}  ${r.notes ?? ''}`);
    }
    process.exit(0);
  }
}
