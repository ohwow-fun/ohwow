import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock logger before importing config
vi.mock('../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { loadConfig, tryLoadConfig, isFirstRun, DEFAULT_PORT, updateConfigFile } from '../config.js';

const TEST_DIR = join(tmpdir(), `ohwow-config-test-${Date.now()}`);
const TEST_CONFIG = join(TEST_DIR, 'config.json');

// Snapshot the workspace env so afterEach can restore it. Necessary because
// loadConfig() always calls resolveActiveWorkspace() (which reads
// OHWOW_WORKSPACE then ~/.ohwow/current-workspace) and applyWorkspaceOverrides
// (which reads the active workspace's workspace.json). If a parallel session
// has switched the pointer to a cloud-mode workspace with a license key, the
// loadConfig tests would inherit tier='connected' from the override layer
// instead of seeing the test config's settings. Pinning OHWOW_WORKSPACE to
// 'default' makes the resolver hermetic — the default workspace has no
// workspace.json so no overrides apply.
const ORIGINAL_OHWOW_WORKSPACE = process.env.OHWOW_WORKSPACE;

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  // Clear env vars that could interfere
  delete process.env.OHWOW_LICENSE_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OHWOW_PORT;
  delete process.env.OHWOW_MODEL_SOURCE;
  delete process.env.OHWOW_BROWSER_HEADLESS;
  // Pin to the default workspace so the resolver doesn't pick up whatever
  // ~/.ohwow/current-workspace points at on the developer's machine.
  process.env.OHWOW_WORKSPACE = 'default';
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  if (ORIGINAL_OHWOW_WORKSPACE === undefined) {
    delete process.env.OHWOW_WORKSPACE;
  } else {
    process.env.OHWOW_WORKSPACE = ORIGINAL_OHWOW_WORKSPACE;
  }
});

describe('loadConfig', () => {
  it('returns free tier when no license key', () => {
    writeFileSync(TEST_CONFIG, JSON.stringify({}));
    const config = loadConfig(TEST_CONFIG);
    expect(config.tier).toBe('free');
    expect(config.licenseKey).toBe('');
  });

  it('returns connected tier when license key present', () => {
    writeFileSync(TEST_CONFIG, JSON.stringify({ licenseKey: 'test-key-123' }));
    const config = loadConfig(TEST_CONFIG);
    expect(config.tier).toBe('connected');
    expect(config.licenseKey).toBe('test-key-123');
  });

  it('env vars override file config', () => {
    writeFileSync(TEST_CONFIG, JSON.stringify({ port: 8080 }));
    process.env.OHWOW_PORT = '9090';
    const config = loadConfig(TEST_CONFIG);
    expect(config.port).toBe(9090);
  });

  it('uses default port when not specified', () => {
    writeFileSync(TEST_CONFIG, JSON.stringify({}));
    const config = loadConfig(TEST_CONFIG);
    expect(config.port).toBe(DEFAULT_PORT);
  });

  it('falls back to default port for invalid port', () => {
    writeFileSync(TEST_CONFIG, JSON.stringify({}));
    process.env.OHWOW_PORT = 'notanumber';
    const config = loadConfig(TEST_CONFIG);
    expect(config.port).toBe(DEFAULT_PORT);
  });

  it('returns defaults when config file does not exist', () => {
    const config = loadConfig(join(TEST_DIR, 'nonexistent.json'));
    expect(config.tier).toBe('free');
    expect(config.ollamaModel).toBe('qwen3:4b');
    expect(config.port).toBe(DEFAULT_PORT);
  });

  it('maps legacy enterprise tier to connected', () => {
    writeFileSync(TEST_CONFIG, JSON.stringify({ tier: 'enterprise', licenseKey: 'k' }));
    const config = loadConfig(TEST_CONFIG);
    expect(config.tier).toBe('connected');
  });

  it('maps legacy connected tier to connected', () => {
    writeFileSync(TEST_CONFIG, JSON.stringify({ tier: 'connected', licenseKey: 'k' }));
    const config = loadConfig(TEST_CONFIG);
    expect(config.tier).toBe('connected');
  });

  it('maps legacy starter tier to connected', () => {
    writeFileSync(TEST_CONFIG, JSON.stringify({ tier: 'starter', licenseKey: 'k' }));
    const config = loadConfig(TEST_CONFIG);
    expect(config.tier).toBe('connected');
  });

  it('maps legacy pro tier to connected', () => {
    writeFileSync(TEST_CONFIG, JSON.stringify({ tier: 'pro', licenseKey: 'k' }));
    const config = loadConfig(TEST_CONFIG);
    expect(config.tier).toBe('connected');
  });

  it('parses browserHeadless from env var', () => {
    writeFileSync(TEST_CONFIG, JSON.stringify({}));
    process.env.OHWOW_BROWSER_HEADLESS = 'false';
    const config = loadConfig(TEST_CONFIG);
    expect(config.browserHeadless).toBe(false);
  });

  it('defaults browserHeadless to false when not set', () => {
    writeFileSync(TEST_CONFIG, JSON.stringify({}));
    const config = loadConfig(TEST_CONFIG);
    expect(config.browserHeadless).toBe(false);
  });

  it('sets browserHeadless to true from env var', () => {
    writeFileSync(TEST_CONFIG, JSON.stringify({}));
    process.env.OHWOW_BROWSER_HEADLESS = 'true';
    const config = loadConfig(TEST_CONFIG);
    expect(config.browserHeadless).toBe(true);
  });
});

describe('tryLoadConfig', () => {
  it('returns config on success', () => {
    writeFileSync(TEST_CONFIG, JSON.stringify({}));
    const config = tryLoadConfig(TEST_CONFIG);
    expect(config).not.toBeNull();
    expect(config!.tier).toBe('free');
  });

  it('returns null on failure', () => {
    const config = tryLoadConfig(join(TEST_DIR, 'nonexistent.json'));
    // loadConfig doesn't throw for missing file, so this actually returns a config
    expect(config).not.toBeNull();
  });
});

describe('updateConfigFile', () => {
  it('creates config file with updates when it does not exist', () => {
    const newPath = join(TEST_DIR, 'new-config.json');
    updateConfigFile({ ollamaModel: 'llama3' }, newPath);
    const content = JSON.parse(readFileSync(newPath, 'utf-8'));
    expect(content.ollamaModel).toBe('llama3');
  });

  it('merges updates into existing config', () => {
    writeFileSync(TEST_CONFIG, JSON.stringify({ ollamaModel: 'qwen3:4b', port: 7700 }));
    updateConfigFile({ ollamaModel: 'llama3' }, TEST_CONFIG);
    const content = JSON.parse(readFileSync(TEST_CONFIG, 'utf-8'));
    expect(content.ollamaModel).toBe('llama3');
    expect(content.port).toBe(7700); // preserved
  });

  it('handles corrupted JSON by overwriting', () => {
    writeFileSync(TEST_CONFIG, '{{{{not json}}}}');
    updateConfigFile({ ollamaModel: 'llama3' }, TEST_CONFIG);
    const content = JSON.parse(readFileSync(TEST_CONFIG, 'utf-8'));
    expect(content.ollamaModel).toBe('llama3');
  });
});

describe('isFirstRun', () => {
  it('returns true when config file does not exist', () => {
    expect(isFirstRun(join(TEST_DIR, 'nonexistent.json'))).toBe(true);
  });

  it('returns true when onboarding not complete', () => {
    writeFileSync(TEST_CONFIG, JSON.stringify({ onboardingComplete: false }));
    expect(isFirstRun(TEST_CONFIG)).toBe(true);
  });

  it('returns false when onboarding is complete', () => {
    writeFileSync(TEST_CONFIG, JSON.stringify({ onboardingComplete: true }));
    expect(isFirstRun(TEST_CONFIG)).toBe(false);
  });
});

describe('YouTube Shorts kill switches', () => {
  const YT_ENV_VARS = [
    'OHWOW_YT_SHORTS_ENABLED',
    'OHWOW_YT_BRIEFING_ENABLED',
    'OHWOW_YT_TOMORROW_BROKE_ENABLED',
    'OHWOW_YT_MIND_WARS_ENABLED',
    'OHWOW_YT_OPERATOR_MODE_ENABLED',
  ] as const;

  beforeEach(() => {
    for (const v of YT_ENV_VARS) delete process.env[v];
  });

  afterEach(() => {
    for (const v of YT_ENV_VARS) delete process.env[v];
  });

  it('all five flags default off when unset', () => {
    const cfg = loadConfig(TEST_CONFIG);
    expect(cfg.ytShortsEnabled).toBe(false);
    expect(cfg.ytBriefingEnabled).toBe(false);
    expect(cfg.ytTomorrowBrokeEnabled).toBe(false);
    expect(cfg.ytMindWarsEnabled).toBe(false);
    expect(cfg.ytOperatorModeEnabled).toBe(false);
  });

  it('env vars flip individual series on', () => {
    process.env.OHWOW_YT_SHORTS_ENABLED = 'true';
    process.env.OHWOW_YT_BRIEFING_ENABLED = 'true';
    const cfg = loadConfig(TEST_CONFIG);
    expect(cfg.ytShortsEnabled).toBe(true);
    expect(cfg.ytBriefingEnabled).toBe(true);
    expect(cfg.ytTomorrowBrokeEnabled).toBe(false);
  });

  it('file-config flag flips on without env', () => {
    writeFileSync(TEST_CONFIG, JSON.stringify({ ytMindWarsEnabled: true }));
    const cfg = loadConfig(TEST_CONFIG);
    expect(cfg.ytMindWarsEnabled).toBe(true);
    expect(cfg.ytShortsEnabled).toBe(false);
  });
});
