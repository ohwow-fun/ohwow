import { describe, it, expect } from 'vitest';
import { executeHostReachTool } from '../host-executor.js';
import { HOST_REACH_TOOL_DEFINITIONS, HOST_REACH_TOOL_NAMES, isHostReachTool } from '../host-tools.js';

describe('host-reach tool definitions', () => {
  it('exports all five typed tools with valid schemas', () => {
    expect(HOST_REACH_TOOL_NAMES).toEqual([
      'notify_user',
      'speak',
      'clipboard_read',
      'clipboard_write',
      'open_url',
    ]);
    for (const tool of HOST_REACH_TOOL_DEFINITIONS) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.input_schema.type).toBe('object');
    }
  });

  it('isHostReachTool recognizes every defined name', () => {
    for (const name of HOST_REACH_TOOL_NAMES) {
      expect(isHostReachTool(name)).toBe(true);
    }
    expect(isHostReachTool('run_bash')).toBe(false);
    expect(isHostReachTool('')).toBe(false);
  });
});

describe('input validation (no shell spawn needed)', () => {
  it('notify_user rejects missing title/body', async () => {
    const r = await executeHostReachTool('notify_user', { title: '', body: 'hi' });
    expect(r.is_error).toBe(true);
    expect(r.content).toMatch(/title.*body/);
  });

  it('notify_user rejects sounds outside the allowed set', async () => {
    const r = await executeHostReachTool('notify_user', {
      title: 't', body: 'b', sound: 'DroidLaserBoom',
    });
    expect(r.is_error).toBe(true);
    expect(r.content).toMatch(/not in the allowed list/);
  });

  it('speak rejects empty text', async () => {
    const r = await executeHostReachTool('speak', { text: '' });
    expect(r.is_error).toBe(true);
  });

  it('speak rejects text over 500 chars (prevents marathon TTS)', async () => {
    const r = await executeHostReachTool('speak', { text: 'x'.repeat(501) });
    expect(r.is_error).toBe(true);
    expect(r.content).toMatch(/500 chars/);
  });

  it('clipboard_write rejects empty text', async () => {
    const r = await executeHostReachTool('clipboard_write', { text: '' });
    expect(r.is_error).toBe(true);
  });

  it('clipboard_write rejects text over 100KB', async () => {
    const r = await executeHostReachTool('clipboard_write', { text: 'x'.repeat(100_001) });
    expect(r.is_error).toBe(true);
  });

  it('open_url rejects non-http(s) schemes — no javascript:, file:, data:', async () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,<x>', 'not a url', '']) {
      const r = await executeHostReachTool('open_url', { url });
      expect(r.is_error).toBe(true);
      expect(r.content).toMatch(/http\(s\) URL/);
    }
  });

  it('unknown tool name returns a clear error', async () => {
    const r = await executeHostReachTool('eject_cdrom', {});
    expect(r.is_error).toBe(true);
    expect(r.content).toMatch(/unknown host-reach tool/);
  });
});
