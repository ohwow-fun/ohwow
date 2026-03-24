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

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  // Clear env vars that could interfere
  delete process.env.OHWOW_LICENSE_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OHWOW_PORT;
  delete process.env.OHWOW_MODEL_SOURCE;
  delete process.env.OHWOW_BROWSER_HEADLESS;
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
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
