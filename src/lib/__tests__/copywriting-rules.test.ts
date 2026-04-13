import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { COPYWRITING_RULES } from '../copywriting-rules.js';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, '..', '..');

/**
 * These tests guard the copywriting-rules propagation fix.
 * Regression source: launch-eve Product Hunt rewrite ran through a
 * sub-agent whose system prompt had no copywriting guidance, and the
 * delegated model happily emitted "OHWOW runs on your machine — no
 * cloud, no API costs" with a live em-dash. The fix is a single
 * COPYWRITING_RULES block imported by BOTH the root orchestrator
 * prompt builder and the sub-agent RuntimeEngine prompt builder.
 * If either import disappears, these tests fail loudly.
 */

describe('COPYWRITING_RULES string', () => {
  it('covers dashes, duration claims, and corporate language rules', () => {
    expect(COPYWRITING_RULES).toContain('No dashes as sentence connectors');
    expect(COPYWRITING_RULES).toContain('No development-time claims');
    expect(COPYWRITING_RULES).toContain('No corporate language');
  });

  it('uses the Unicode codepoint labels instead of literal em-dashes', () => {
    // The rules must not emit literal em-dashes or en-dashes because
    // the LLM mirrors training-data style. Describe the banned chars
    // by their codepoint names so the banned glyphs never enter the
    // prompt surface.
    expect(COPYWRITING_RULES).not.toMatch(/\u2014/);
    expect(COPYWRITING_RULES).not.toMatch(/\u2013/);
  });
});

describe('copywriting-rules propagation wiring', () => {
  it('engine.ts imports COPYWRITING_RULES and splices it into buildSystemPrompt', () => {
    const enginePath = join(srcRoot, 'execution', 'engine.ts');
    const source = readFileSync(enginePath, 'utf8');
    expect(source).toMatch(/from '\.\.\/lib\/copywriting-rules\.js'/);
    expect(source).toMatch(/COPYWRITING_RULES/);
    // Sub-agent prompt template must splice the block in.
    const buildIdx = source.indexOf('private buildSystemPrompt(');
    expect(buildIdx).toBeGreaterThan(-1);
    const buildBlock = source.slice(buildIdx, buildIdx + 5000);
    expect(buildBlock).toMatch(/\$\{COPYWRITING_RULES\}/);
  });

  it('system-prompt.ts imports both rule variants and splices them into the right renderers', () => {
    const sysPromptPath = join(srcRoot, 'orchestrator', 'system-prompt.ts');
    const source = readFileSync(sysPromptPath, 'utf8');
    expect(source).toMatch(/from '\.\.\/lib\/copywriting-rules\.js'/);
    // Full orchestrator context gets the full block.
    expect(source).toMatch(/\$\{COPYWRITING_RULES\}/);
    // Compact context (sub-2B models) gets the terse variant.
    expect(source).toMatch(/\$\{COPYWRITING_RULES_COMPACT\}/);
  });
});
