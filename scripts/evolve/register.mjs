/**
 * register.mjs — create-or-update the ohwow:self-evolve automation.
 *
 * Registers the self-evolution system as an ohwow automation that runs
 * every 4 hours. Safe to run multiple times (idempotent).
 *
 * Usage:
 *   node scripts/evolve/register.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Read daemon token and port
// ---------------------------------------------------------------------------

function readToken() {
  const candidates = [
    path.join(os.homedir(), '.ohwow', 'workspaces', 'default', 'daemon.token'),
    path.join(os.homedir(), '.ohwow', 'data', 'daemon.token'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return fs.readFileSync(p, 'utf8').trim();
    }
  }
  throw new Error('daemon.token not found. Is the daemon running? Try: ohwow workspace start');
}

function readPort() {
  const wsJson = path.join(os.homedir(), '.ohwow', 'workspaces', 'default', 'workspace.json');
  if (fs.existsSync(wsJson)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(wsJson, 'utf8'));
      if (typeof cfg.port === 'number') return cfg.port;
    } catch {
      // fall through to default
    }
  }
  return 7700;
}

// ---------------------------------------------------------------------------
// Automation config
// ---------------------------------------------------------------------------

const AUTOMATION_CONFIG = {
  name: 'ohwow:self-evolve',
  description: 'Self-evolving code improvement: picks the next bounded task, implements via Claude, validates, commits',
  enabled: true,
  trigger_type: 'schedule',
  trigger_config: { cron: '0 */4 * * *' }, // every 4 hours
  cooldown_seconds: 14400, // 4 hours — one task per window
  steps: [
    {
      id: 'step_1',
      step_type: 'shell_script',
      label: 'Run self-evolution cycle',
      action_config: {
        script_path: 'scripts/evolve/self-evolve.mjs',
        timeout_seconds: 1800,
        heartbeat_filename: 'self-evolve-heartbeat',
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const token = readToken();
  const port = readPort();
  const base = `http://localhost:${port}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  console.log(`[register] daemon at ${base}`);

  // GET /api/automations — check if ohwow:self-evolve already exists
  const listRes = await fetch(`${base}/api/automations`, { headers });
  if (!listRes.ok) {
    throw new Error(`GET /api/automations failed: HTTP ${listRes.status}`);
  }
  const listBody = await listRes.json();
  const existing = (listBody.data ?? []).find(a => a.name === AUTOMATION_CONFIG.name);

  let result;

  if (existing) {
    console.log(`[register] found existing automation id=${existing.id} — PATCHing...`);
    const patchRes = await fetch(`${base}/api/automations/${existing.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(AUTOMATION_CONFIG),
    });
    if (!patchRes.ok) {
      const text = await patchRes.text();
      throw new Error(`PATCH /api/automations/${existing.id} failed: HTTP ${patchRes.status}\n${text}`);
    }
    const patchBody = await patchRes.json();
    result = patchBody.automation ?? patchBody;
    console.log(`[register] updated: id=${result.id}`);
  } else {
    console.log(`[register] not found — POSTing new automation...`);
    const postRes = await fetch(`${base}/api/automations`, {
      method: 'POST',
      headers,
      body: JSON.stringify(AUTOMATION_CONFIG),
    });
    if (!postRes.ok) {
      const text = await postRes.text();
      throw new Error(`POST /api/automations failed: HTTP ${postRes.status}\n${text}`);
    }
    const postBody = await postRes.json();
    result = postBody.automation ?? postBody;
    console.log(`[register] created: id=${result.id}`);
  }

  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

main().catch(err => {
  console.error(`[register] ERROR: ${err.message}`);
  process.exit(1);
});
