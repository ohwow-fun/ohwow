/**
 * register-automation.mjs — create-or-update the ohwow:market-intel automation.
 *
 * Run this whenever you want to ensure the automation is registered correctly
 * on the current daemon. Safe to run multiple times (idempotent).
 *
 * Usage:
 *   node scripts/intel/register-automation.mjs
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
  name: 'ohwow:market-intel',
  description: 'Daily market intelligence: model releases, buyer leads, research, competitor signals',
  enabled: true,
  trigger_type: 'schedule',
  trigger_config: { cron: '0 6 * * *' },
  cooldown_seconds: 82800,
  steps: [
    {
      id: 'step_1',
      step_type: 'shell_script',
      label: 'Run market-intel pipeline',
      action_config: {
        script_path: 'scripts/intel/market-intel.mjs',
        timeout_seconds: 900,
        heartbeat_filename: 'market-intel-heartbeat',
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

  console.log(`[register-automation] daemon at ${base}`);

  // GET /api/automations — check if ohwow:market-intel already exists
  const listRes = await fetch(`${base}/api/automations`, { headers });
  if (!listRes.ok) {
    throw new Error(`GET /api/automations failed: HTTP ${listRes.status}`);
  }
  const listBody = await listRes.json();
  const existing = (listBody.data ?? []).find(a => a.name === AUTOMATION_CONFIG.name);

  let result;

  if (existing) {
    console.log(`[register-automation] found existing automation id=${existing.id} — PATCHing...`);
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
    console.log(`[register-automation] updated: id=${result.id}`);
  } else {
    console.log(`[register-automation] not found — POSTing new automation...`);
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
    console.log(`[register-automation] created: id=${result.id}`);
  }

  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

main().catch(err => {
  console.error(`[register-automation] ERROR: ${err.message}`);
  process.exit(1);
});
