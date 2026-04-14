/**
 * Fixture coverage for the schema↔handler audit. Writes small
 * synthetic handler files to a tmp directory, runs the AST walker
 * against them, asserts the correct severity is reported for each
 * known pattern. Pure; no dependency on the real tool catalog.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  auditHandler,
  runAudit,
  formatAuditReport,
  type HandlerAuditInput,
} from '../schema-handler-audit.js';

interface Fixture {
  dir: string;
  writeHandler: (name: string, src: string) => string;
}

function setupFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'ohwow-audit-'));
  return {
    dir,
    writeHandler: (name, src) => {
      const path = join(dir, name);
      writeFileSync(path, src);
      return path;
    },
  };
}

function teardownFixture(f: Fixture) {
  rmSync(f.dir, { recursive: true, force: true });
}

describe('schema-handler-audit AST walker', () => {
  let fixture: Fixture;

  beforeEach(() => { fixture = setupFixture(); });
  afterEach(() => { teardownFixture(fixture); });

  it('classifies a clean handler as clean', () => {
    const handlerFile = fixture.writeHandler(
      'clean.ts',
      `
export async function cleanHandler(ctx: unknown, input: Record<string, unknown>): Promise<unknown> {
  const agentId = input.agent_id as string;
  const action = input.action as string;
  return { agentId, action };
}
      `.trim(),
    );

    const input: HandlerAuditInput = {
      tool: 'clean_tool',
      schemaProperties: ['agent_id', 'action'],
      schemaRequired: ['agent_id'],
      handlerFile,
      handlerExportName: 'cleanHandler',
    };

    const result = auditHandler(input);
    expect(result.severity).toBe('clean');
    expect(result.handlerFound).toBe(true);
    expect([...result.shape.readKeys].sort()).toEqual(['action', 'agent_id']);
    expect(result.declaredNotRead).toEqual([]);
    expect(result.readNotDeclared).toEqual([]);
  });

  it('catches destructuring at variable-declaration level', () => {
    const handlerFile = fixture.writeHandler(
      'destruct.ts',
      `
export async function destructHandler(ctx: unknown, input: Record<string, unknown>) {
  const { title, content, type } = input;
  return { title, content, type };
}
      `.trim(),
    );

    const result = auditHandler({
      tool: 'destruct_tool',
      schemaProperties: ['title', 'content', 'type'],
      schemaRequired: ['title', 'content', 'type'],
      handlerFile,
      handlerExportName: 'destructHandler',
    });
    expect(result.severity).toBe('clean');
    expect([...result.shape.readKeys].sort()).toEqual(['content', 'title', 'type']);
  });

  it('catches destructuring at the parameter signature level', () => {
    const handlerFile = fixture.writeHandler(
      'param-destruct.ts',
      `
export async function paramDestructHandler(
  ctx: unknown,
  { title, content }: Record<string, unknown>,
) {
  return { title, content };
}
      `.trim(),
    );

    const result = auditHandler({
      tool: 'param_destruct_tool',
      schemaProperties: ['title', 'content'],
      schemaRequired: ['title'],
      handlerFile,
      handlerExportName: 'paramDestructHandler',
    });
    expect(result.severity).toBe('clean');
    expect([...result.shape.readKeys].sort()).toEqual(['content', 'title']);
  });

  it('unwraps `input as Foo` casts when checking destructuring initializers', () => {
    // The idiomatic pattern across every whatsapp/telegram handler
    // in the real catalog. The walker missed it on first draft and
    // reported every declared field as unread — a false major.
    const handlerFile = fixture.writeHandler(
      'cast.ts',
      `
export async function castHandler(ctx: unknown, input: Record<string, unknown>) {
  const { chat_id, message, media_path } = input as {
    chat_id: string;
    message?: string;
    media_path?: string;
  };
  if (!chat_id) return { success: false };
  return { chat_id, message, media_path };
}
      `.trim(),
    );

    const result = auditHandler({
      tool: 'cast_tool',
      schemaProperties: ['chat_id', 'message', 'media_path'],
      schemaRequired: ['chat_id'],
      handlerFile,
      handlerExportName: 'castHandler',
    });
    expect(result.severity).toBe('clean');
    expect([...result.shape.readKeys].sort()).toEqual(['chat_id', 'media_path', 'message']);
    expect(result.requiredNotRead).toEqual([]);
  });

  it('unwraps non-null assertions `input!.foo` and parentheses', () => {
    const handlerFile = fixture.writeHandler(
      'nonnull.ts',
      `
export async function nonNullHandler(ctx: unknown, input: Record<string, unknown>) {
  const a = (input as Record<string, unknown>).a as string;
  const b = input!.b;
  return { a, b };
}
      `.trim(),
    );

    const result = auditHandler({
      tool: 'nonnull_tool',
      schemaProperties: ['a', 'b'],
      schemaRequired: ['a', 'b'],
      handlerFile,
      handlerExportName: 'nonNullHandler',
    });
    expect([...result.shape.readKeys].sort()).toEqual(['a', 'b']);
    expect(result.severity).toBe('clean');
  });

  it('catches bracket-style reads input["foo"]', () => {
    const handlerFile = fixture.writeHandler(
      'bracket.ts',
      `
export async function bracketHandler(ctx: unknown, input: Record<string, unknown>) {
  const agentId = input['agent_id'] as string;
  return { agentId };
}
      `.trim(),
    );

    const result = auditHandler({
      tool: 'bracket_tool',
      schemaProperties: ['agent_id'],
      schemaRequired: ['agent_id'],
      handlerFile,
      handlerExportName: 'bracketHandler',
    });
    expect([...result.shape.readKeys]).toEqual(['agent_id']);
    expect(result.severity).toBe('clean');
  });

  it('flags a MAJOR finding when a required field is never read', () => {
    const handlerFile = fixture.writeHandler(
      'missing-required.ts',
      `
export async function missingRequiredHandler(ctx: unknown, input: Record<string, unknown>) {
  // Handler only reads 'status' but schema declares 'agent_id' as required
  const status = input.status as string;
  return { status };
}
      `.trim(),
    );

    const result = auditHandler({
      tool: 'missing_required_tool',
      schemaProperties: ['agent_id', 'status'],
      schemaRequired: ['agent_id'],
      handlerFile,
      handlerExportName: 'missingRequiredHandler',
    });
    expect(result.severity).toBe('major');
    expect(result.requiredNotRead).toEqual(['agent_id']);
    expect(result.declaredNotRead).toEqual(['agent_id']);
  });

  it('flags a MINOR finding for declared-not-read when the field is optional', () => {
    const handlerFile = fixture.writeHandler(
      'dead-schema.ts',
      `
export async function deadSchemaHandler(ctx: unknown, input: Record<string, unknown>) {
  const status = input.status as string;
  return { status };
}
      `.trim(),
    );

    const result = auditHandler({
      tool: 'dead_schema_tool',
      schemaProperties: ['status', 'legacy_field'],
      schemaRequired: ['status'],
      handlerFile,
      handlerExportName: 'deadSchemaHandler',
    });
    expect(result.severity).toBe('minor');
    expect(result.declaredNotRead).toEqual(['legacy_field']);
    expect(result.readNotDeclared).toEqual([]);
    expect(result.requiredNotRead).toEqual([]);
  });

  it('flags a MINOR finding for read-not-declared (undocumented handler dependency)', () => {
    const handlerFile = fixture.writeHandler(
      'undocumented.ts',
      `
export async function undocumentedHandler(ctx: unknown, input: Record<string, unknown>) {
  const status = input.status as string;
  const secretFlag = input.secret_flag as boolean;
  return { status, secretFlag };
}
      `.trim(),
    );

    const result = auditHandler({
      tool: 'undocumented_tool',
      schemaProperties: ['status'],
      schemaRequired: ['status'],
      handlerFile,
      handlerExportName: 'undocumentedHandler',
    });
    expect(result.severity).toBe('minor');
    expect(result.readNotDeclared).toEqual(['secret_flag']);
  });

  it('suppresses declared-not-read when the handler spreads the whole input', () => {
    const handlerFile = fixture.writeHandler(
      'spread.ts',
      `
export async function spreadHandler(ctx: unknown, input: Record<string, unknown>) {
  const merged = { ...input, timestamp: Date.now() };
  return merged;
}
      `.trim(),
    );

    const result = auditHandler({
      tool: 'spread_tool',
      schemaProperties: ['foo', 'bar', 'baz'],
      schemaRequired: ['foo'],
      handlerFile,
      handlerExportName: 'spreadHandler',
    });
    expect(result.severity).toBe('clean');
    expect(result.shape.spreadRead).toBe(true);
    expect(result.declaredNotRead).toEqual([]);
    expect(result.notes.some((n) => n.includes('spreads the entire input'))).toBe(true);
  });

  it('suppresses declared-not-read when the handler passes input through to a helper', () => {
    const handlerFile = fixture.writeHandler(
      'passthrough.ts',
      `
function helper(input: Record<string, unknown>) { return input; }
export async function passthroughHandler(ctx: unknown, input: Record<string, unknown>) {
  return helper(input);
}
      `.trim(),
    );

    const result = auditHandler({
      tool: 'passthrough_tool',
      schemaProperties: ['x', 'y'],
      schemaRequired: ['x'],
      handlerFile,
      handlerExportName: 'passthroughHandler',
    });
    expect(result.severity).toBe('clean');
    expect(result.shape.passthroughRead).toBe(true);
    expect(result.declaredNotRead).toEqual([]);
  });

  it('notes dynamic input[var] reads without false-flagging static fields', () => {
    const handlerFile = fixture.writeHandler(
      'dynamic.ts',
      `
export async function dynamicHandler(ctx: unknown, input: Record<string, unknown>) {
  const key = 'status';
  const value = input[key];
  const agentId = input.agent_id as string;
  return { value, agentId };
}
      `.trim(),
    );

    const result = auditHandler({
      tool: 'dynamic_tool',
      schemaProperties: ['agent_id', 'status'],
      schemaRequired: ['agent_id'],
      handlerFile,
      handlerExportName: 'dynamicHandler',
    });
    expect(result.shape.dynamicRead).toBe(true);
    expect(result.shape.readKeys.has('agent_id')).toBe(true);
    expect(result.notes.some((n) => n.includes('dynamic'))).toBe(true);
    // status is never statically read, but the dynamic note lets
    // the human tell the difference between real dead schema and a
    // probe limitation. Severity is still minor because the static
    // analysis can't confirm status is actually read.
    expect(result.severity).toBe('minor');
  });

  it('returns handlerFound=false for an unknown export name', () => {
    const handlerFile = fixture.writeHandler(
      'missing.ts',
      `
export async function someOtherName(ctx: unknown, input: Record<string, unknown>) {
  return input.foo;
}
      `.trim(),
    );

    const result = auditHandler({
      tool: 'missing_tool',
      schemaProperties: ['foo'],
      schemaRequired: [],
      handlerFile,
      handlerExportName: 'definitelyNotThere',
    });
    expect(result.handlerFound).toBe(false);
    expect(result.verdict).toContain('skip:');
  });

  it('handles const-export arrow functions', () => {
    const handlerFile = fixture.writeHandler(
      'arrow.ts',
      `
export const arrowHandler = async (ctx: unknown, input: Record<string, unknown>) => {
  const id = input.id as string;
  return { id };
};
      `.trim(),
    );

    const result = auditHandler({
      tool: 'arrow_tool',
      schemaProperties: ['id'],
      schemaRequired: ['id'],
      handlerFile,
      handlerExportName: 'arrowHandler',
    });
    expect(result.handlerFound).toBe(true);
    expect([...result.shape.readKeys]).toEqual(['id']);
    expect(result.severity).toBe('clean');
  });

  it('handles const-export arrow functions behind a ToolHandler type alias', () => {
    const handlerFile = fixture.writeHandler(
      'typed-arrow.ts',
      `
type ToolHandler = (ctx: unknown, input: Record<string, unknown>) => Promise<unknown>;
export const typedArrowHandler: ToolHandler = async (ctx, input) => {
  const skillId = input.skill_id as string;
  return { skillId };
};
      `.trim(),
    );

    const result = auditHandler({
      tool: 'typed_arrow_tool',
      schemaProperties: ['skill_id'],
      schemaRequired: ['skill_id'],
      handlerFile,
      handlerExportName: 'typedArrowHandler',
    });
    expect(result.handlerFound).toBe(true);
    expect([...result.shape.readKeys]).toEqual(['skill_id']);
    expect(result.severity).toBe('clean');
  });
});

describe('runAudit batch + formatAuditReport', () => {
  let fixture: Fixture;

  beforeEach(() => { fixture = setupFixture(); });
  afterEach(() => { teardownFixture(fixture); });

  it('aggregates multiple audits into a summary with severity tags', () => {
    const cleanFile = fixture.writeHandler(
      'a.ts',
      `export async function a(_ctx: unknown, input: Record<string, unknown>) { return input.x; }`,
    );
    const minorFile = fixture.writeHandler(
      'b.ts',
      `export async function b(_ctx: unknown, input: Record<string, unknown>) { return input.x; }`,
    );
    const majorFile = fixture.writeHandler(
      'c.ts',
      `export async function c(_ctx: unknown, input: Record<string, unknown>) { return input.y; }`,
    );

    const run = runAudit([
      { tool: 'a', schemaProperties: ['x'], schemaRequired: ['x'], handlerFile: cleanFile, handlerExportName: 'a' },
      { tool: 'b', schemaProperties: ['x', 'dead'], schemaRequired: ['x'], handlerFile: minorFile, handlerExportName: 'b' },
      { tool: 'c', schemaProperties: ['y', 'important'], schemaRequired: ['important'], handlerFile: majorFile, handlerExportName: 'c' },
    ]);

    expect(run.summary.total).toBe(3);
    expect(run.summary.clean).toBe(1);
    expect(run.summary.minor).toBe(1);
    expect(run.summary.major).toBe(1);

    const report = formatAuditReport(run);
    expect(report).toContain('schema↔handler audit');
    expect(report).toContain('🔴');
    expect(report).toContain('🟡');
    expect(report).toContain('🟢');
    expect(report).toContain('REQUIRED-NOT-READ: important');
  });
});
