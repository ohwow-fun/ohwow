import { describe, it, expect } from 'vitest';
import {
  LOG_TAIL_TOOL_DEFINITIONS,
  LOG_TAIL_TOOL_NAMES,
  isLogTailTool,
  buildLogTailArgv,
  computeErrorDensity,
  executeLogTail,
} from '../index.js';

describe('log_tail tool definitions', () => {
  it('exports a single typed tool with a service enum', () => {
    expect(LOG_TAIL_TOOL_NAMES).toEqual(['log_tail']);
    const [tool] = LOG_TAIL_TOOL_DEFINITIONS;
    expect(tool.name).toBe('log_tail');
    expect(tool.description).toBeTruthy();
    const schema = tool.input_schema as {
      type: string;
      properties: { service: { enum: string[] } };
      required: string[];
    };
    expect(schema.type).toBe('object');
    expect(schema.properties.service.enum).toEqual(['supabase', 'vercel', 'fly', 'modal']);
    expect(schema.required).toEqual(['service']);
  });

  it('isLogTailTool recognizes log_tail only', () => {
    expect(isLogTailTool('log_tail')).toBe(true);
    expect(isLogTailTool('run_bash')).toBe(false);
    expect(isLogTailTool('')).toBe(false);
  });
});

describe('buildLogTailArgv', () => {
  it('constructs supabase argv with project ref + limit', () => {
    const r = buildLogTailArgv('supabase', 'proj_example', 50, {});
    expect(r.ok).toBe(true);
    expect(r.cmd).toBe('supabase');
    expect(r.argv).toEqual(['logs', '--project-ref', 'proj_example', '--limit', '50']);
  });

  it('falls back to OHWOW_SUPABASE_PROJECT_REF env', () => {
    const r = buildLogTailArgv('supabase', undefined, 100, { OHWOW_SUPABASE_PROJECT_REF: 'env_ref' });
    expect(r.ok).toBe(true);
    expect(r.argv).toContain('env_ref');
    expect(r.target).toBe('env_ref');
  });

  it('returns missing_target when supabase has no ref', () => {
    const r = buildLogTailArgv('supabase', undefined, 100, {});
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/missing_target/);
  });

  it('vercel argv is valid without target (uses linked project)', () => {
    const r = buildLogTailArgv('vercel', undefined, 25, {});
    expect(r.ok).toBe(true);
    expect(r.cmd).toBe('vercel');
    expect(r.argv).toEqual(['logs', '--number', '25']);
  });

  it('vercel includes project when provided', () => {
    const r = buildLogTailArgv('vercel', 'my-app', 25, {});
    expect(r.argv).toEqual(['logs', 'my-app', '--number', '25']);
  });

  it('fly uses flyctl with --no-tail', () => {
    const r = buildLogTailArgv('fly', 'my-fly-app', 100, {});
    expect(r.ok).toBe(true);
    expect(r.cmd).toBe('flyctl');
    expect(r.argv).toEqual(['logs', '--app', 'my-fly-app', '--no-tail']);
  });

  it('modal uses modal app logs', () => {
    const r = buildLogTailArgv('modal', 'my-modal-app', 100, {});
    expect(r.ok).toBe(true);
    expect(r.cmd).toBe('modal');
    expect(r.argv).toEqual(['app', 'logs', 'my-modal-app']);
  });

  it('clamps lines to [1, 2000]', () => {
    const high = buildLogTailArgv('supabase', 'ref', 99_999, {});
    expect(high.argv).toContain('2000');
    const low = buildLogTailArgv('supabase', 'ref', 0, {});
    expect(low.argv).toContain('1');
  });
});

describe('computeErrorDensity', () => {
  it('counts lines matching error-like tokens', () => {
    const out = [
      'INFO ok',
      'ERROR something broke',
      'warn retrying',
      '500 server error',
      'fatal: out of memory',
      '',
    ].join('\n');
    const { lines, density } = computeErrorDensity(out);
    expect(lines).toBe(5);
    expect(density).toBeCloseTo(3 / 5, 4);
  });

  it('returns 0 density on empty output', () => {
    const { lines, density } = computeErrorDensity('');
    expect(lines).toBe(0);
    expect(density).toBe(0);
  });
});

describe('executeLogTail', () => {
  it('returns invalid_service for unknown service', async () => {
    const r = await executeLogTail({ service: 'aws' });
    expect(r.is_error).toBe(true);
    const payload = JSON.parse(r.content);
    expect(payload.ok).toBe(false);
    expect(payload.reason).toMatch(/invalid_service/);
  });

  it('no-ops gracefully when target + env are missing', async () => {
    const r = await executeLogTail({ service: 'fly' }, { env: {} });
    expect(r.is_error).toBeFalsy();
    const payload = JSON.parse(r.content);
    expect(payload.ok).toBe(false);
    expect(payload.reason).toMatch(/missing_target/);
  });

  it('reports cli_unavailable when spawner signals exit 127', async () => {
    const spawner = async () => ({ stdout: '', stderr: '', exitCode: 127, spawnError: 'ENOENT' });
    const r = await executeLogTail(
      { service: 'supabase', target: 'proj_example', lines: 10 },
      { spawner, env: {} },
    );
    const payload = JSON.parse(r.content);
    expect(payload.ok).toBe(false);
    expect(payload.reason).toMatch(/cli_unavailable/);
  });

  it('reports missing_credentials when CLI emits auth error', async () => {
    const spawner = async () => ({
      stdout: '',
      stderr: 'Error: not logged in. Run `supabase login` first.',
      exitCode: 1,
    });
    const r = await executeLogTail(
      { service: 'supabase', target: 'proj_example' },
      { spawner, env: {} },
    );
    const payload = JSON.parse(r.content);
    expect(payload.ok).toBe(false);
    expect(payload.reason).toMatch(/missing_credentials/);
  });

  it('returns ok=true with error_density on successful output', async () => {
    const stdout = [
      'INFO request ok',
      'ERROR upstream timeout',
      'INFO request ok',
      'WARN slow query',
    ].join('\n');
    const spawner = async (cmd: string, argv: string[]) => {
      expect(cmd).toBe('supabase');
      expect(argv).toEqual(['logs', '--project-ref', 'proj_example', '--limit', '200']);
      return { stdout, stderr: '', exitCode: 0 };
    };
    const r = await executeLogTail(
      { service: 'supabase', target: 'proj_example' },
      { spawner, env: {} },
    );
    const payload = JSON.parse(r.content);
    expect(payload.ok).toBe(true);
    expect(payload.service).toBe('supabase');
    expect(payload.target).toBe('proj_example');
    expect(payload.lines_returned).toBe(4);
    expect(payload.error_density).toBeCloseTo(1 / 4, 4);
    expect(payload.output).toBe(stdout);
  });
});
