/**
 * Agent Tool Policy Tests
 *
 * Locks the resolver behavior the engine relies on for Bug 1 / Bug 3:
 *  - canonical `tools_enabled` + `tools_mode` fields win over legacy
 *    `allowed_tools` / `blocked_tools`
 *  - an allowlist populated without an explicit mode is treated as strict
 *  - `mcp__<server>__<tool>` entries are parsed into the referenced server
 *    set and flip `requiresMcp`
 *  - `filterToolsByPolicy` is exclusive in allowlist mode and additive in
 *    inherit mode
 *  - `allowlistPermits` lets the engine gate feature-flag defaults
 *    (web_search, browser, etc.) against the allowlist
 */

import { describe, it, expect } from 'vitest';
import {
  resolveAgentToolPolicy,
  filterToolsByPolicy,
  allowlistPermits,
} from '../agent-tool-policy.js';

describe('resolveAgentToolPolicy', () => {
  it('returns an empty inherit policy when the config is undefined', () => {
    const p = resolveAgentToolPolicy(undefined);
    expect(p.mode).toBe('inherit');
    expect(p.allowedNames.size).toBe(0);
    expect(p.blockedNames.size).toBe(0);
    expect(p.requiresMcp).toBe(false);
  });

  it('treats tools_enabled with tools_mode: "allowlist" as strict', () => {
    const p = resolveAgentToolPolicy({
      tools_mode: 'allowlist',
      tools_enabled: ['list_tasks', 'scrape_url'],
    });
    expect(p.mode).toBe('allowlist');
    expect([...p.allowedNames]).toEqual(['list_tasks', 'scrape_url']);
  });

  it('treats a populated tools_enabled with no mode as allowlist', () => {
    // Matches the API create route's "populated list without explicit mode
    // => allowlist" convention the MCP typed tools rely on.
    const p = resolveAgentToolPolicy({
      tools_enabled: ['list_tasks'],
    });
    expect(p.mode).toBe('allowlist');
    expect(p.allowedNames.has('list_tasks')).toBe(true);
  });

  it('respects an explicit inherit mode even with a populated list', () => {
    const p = resolveAgentToolPolicy({
      tools_mode: 'inherit',
      tools_enabled: ['list_tasks'],
    });
    expect(p.mode).toBe('inherit');
    expect(p.allowedNames.has('list_tasks')).toBe(true);
  });

  it('falls back to legacy allowed_tools / blocked_tools when canonical is missing', () => {
    const p = resolveAgentToolPolicy({
      allowed_tools: ['alpha', 'beta'],
      blocked_tools: ['gamma'],
    });
    // Empty canonical list still lets legacy drive.
    expect([...p.allowedNames]).toEqual(['alpha', 'beta']);
    expect([...p.blockedNames]).toEqual(['gamma']);
  });

  it('parses MCP server names out of mcp__<server>__<tool> entries', () => {
    const p = resolveAgentToolPolicy({
      tools_mode: 'allowlist',
      tools_enabled: [
        'list_tasks',
        'mcp__avenued-prod-superadmin__avenued_get_platform_health',
        'mcp__avenued-prod-superadmin__avenued_list_communities',
        'mcp__github__list_issues',
      ],
    });
    expect(p.requiresMcp).toBe(true);
    expect([...p.referencedMcpServers].sort()).toEqual(
      ['avenued-prod-superadmin', 'github'].sort(),
    );
  });

  it('requiresMcp stays false when no mcp__ entries are present', () => {
    const p = resolveAgentToolPolicy({
      tools_mode: 'allowlist',
      tools_enabled: ['list_tasks', 'scrape_url'],
    });
    expect(p.requiresMcp).toBe(false);
    expect(p.referencedMcpServers.size).toBe(0);
  });
});

describe('filterToolsByPolicy', () => {
  const tools = [
    { name: 'list_tasks' },
    { name: 'web_search' },
    { name: 'request_browser' },
    { name: 'mcp__avenued__get_health' },
    { name: 'mcp__avenued__list_users' },
  ];

  it('allowlist mode keeps only listed names and drops everything else', () => {
    const policy = resolveAgentToolPolicy({
      tools_mode: 'allowlist',
      tools_enabled: ['list_tasks', 'mcp__avenued__get_health'],
    });
    const filtered = filterToolsByPolicy(tools, policy);
    expect(filtered.map(t => t.name)).toEqual([
      'list_tasks',
      'mcp__avenued__get_health',
    ]);
  });

  it('allowlist mode with an empty explicit list produces an empty surface', () => {
    // Bug 3 regression: explicit allowlist mode is strict, and an empty
    // `tools_enabled` means "nothing" — not "everything".
    const policy = resolveAgentToolPolicy({
      tools_mode: 'allowlist',
      tools_enabled: [],
    });
    expect(policy.mode).toBe('allowlist');
    const filtered = filterToolsByPolicy(tools, policy);
    expect(filtered).toEqual([]);
  });

  it('inherit mode with a populated allowlist narrows the surface', () => {
    const policy = resolveAgentToolPolicy({
      tools_mode: 'inherit',
      tools_enabled: ['list_tasks'],
    });
    const filtered = filterToolsByPolicy(tools, policy);
    expect(filtered.map(t => t.name)).toEqual(['list_tasks']);
  });

  it('inherit mode with a blocklist removes blocked entries', () => {
    const policy = resolveAgentToolPolicy({
      blocked_tools: ['web_search', 'request_browser'],
    });
    const filtered = filterToolsByPolicy(tools, policy);
    expect(filtered.map(t => t.name)).toEqual([
      'list_tasks',
      'mcp__avenued__get_health',
      'mcp__avenued__list_users',
    ]);
  });
});

describe('allowlistPermits', () => {
  it('lets everything through in inherit mode', () => {
    const policy = resolveAgentToolPolicy({});
    expect(allowlistPermits(policy, 'web_search')).toBe(true);
    expect(allowlistPermits(policy, 'request_browser')).toBe(true);
  });

  it('only permits names in the allowlist when in allowlist mode', () => {
    const policy = resolveAgentToolPolicy({
      tools_mode: 'allowlist',
      tools_enabled: ['list_tasks'],
    });
    expect(allowlistPermits(policy, 'list_tasks')).toBe(true);
    expect(allowlistPermits(policy, 'web_search')).toBe(false);
    expect(allowlistPermits(policy, 'request_browser')).toBe(false);
  });

  it('permits run_bash when present in the allowlist', () => {
    // Regression: the bash capability gate in task-capabilities.ts previously
    // checked the string 'bash_execute' — a name that exists nowhere else —
    // so allowlist-mode agents could never receive BASH_TOOL_DEFINITIONS
    // even when they explicitly listed run_bash.
    const policy = resolveAgentToolPolicy({
      tools_mode: 'allowlist',
      tools_enabled: ['run_bash', 'local_read_file'],
    });
    expect(allowlistPermits(policy, 'run_bash')).toBe(true);
    expect(allowlistPermits(policy, 'bash_execute')).toBe(false);
  });
});
