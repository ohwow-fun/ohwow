/**
 * Schema↔handler static audit
 *
 * For every registered tool, cross-check its declared `input_schema`
 * against what the handler actually reads. A mismatch is a contract
 * bug the model will trip on the first time that tool is called with
 * a realistic payload:
 *
 *   - declared_not_read — schema lists a property the handler never
 *     touches. Dead schema field. The model will pass it, the
 *     handler will silently ignore it, and the user will think
 *     they've set something when they haven't. S3.12-class bug but
 *     in the opposite direction from the orphan-schema audit.
 *
 *   - read_not_declared — handler reads an input field that isn't
 *     in the schema. The model has no way to know it can pass that
 *     field, so a feature is dead code until the schema catches up.
 *     Also the reverse of S3.12 — handlers whose contract is bigger
 *     than their schema tells the model.
 *
 *   - required_not_read — schema marks a field as required but the
 *     handler never reads it. Usually a refactor artifact: the
 *     handler used to take the field, was rewritten, and nobody
 *     trimmed the `required` array.
 *
 * This module parses handler sources via the TypeScript compiler
 * API — not regex — so destructuring patterns like
 * `const { foo, bar } = input` and parameter bindings like
 * `function h(ctx, { foo, bar })` are caught correctly along with
 * plain `input.foo` and `input['foo']` reads. Dynamic keys like
 * `input[dynamicVar]` are reported as a distinct signal (the probe
 * found a dynamic read but can't tell which keys it might resolve
 * to) so the fuzz can note them rather than falsely flag fields as
 * unused.
 *
 * Pure; no runtime execution of handlers. The audit runs as a test
 * that reads source files off disk.
 */

import ts from 'typescript';
import { readFileSync } from 'node:fs';

// ============================================================================
// TYPES
// ============================================================================

/**
 * A single tool to audit. The caller supplies the tool name, its
 * declared schema shape (properties + required), and a pointer to
 * the handler function by source file + exported name.
 */
export interface HandlerAuditInput {
  tool: string;
  /** Properties declared in the tool's input_schema. */
  schemaProperties: string[];
  /** Required fields from the tool's input_schema. */
  schemaRequired: string[];
  /** Enum values declared per-property, if any. */
  schemaEnums?: Record<string, string[]>;
  /** Source file path (absolute) containing the handler. */
  handlerFile: string;
  /**
   * Name of the exported function / const the registry dispatches
   * to. The audit uses this to locate the function body inside the
   * source file.
   */
  handlerExportName: string;
}

/** What the AST walk observed the handler actually touching. */
export interface HandlerReadShape {
  /** Unique set of `input.<name>` or destructured names. */
  readKeys: Set<string>;
  /** True when a dynamic read like `input[dynamicVar]` was spotted. */
  dynamicRead: boolean;
  /** True when a spread or full-object read like `{...input}` was spotted. */
  spreadRead: boolean;
  /** True when the whole `input` was passed to another function. */
  passthroughRead: boolean;
}

export interface HandlerAuditResult {
  tool: string;
  handlerFile: string;
  handlerExportName: string;
  shape: HandlerReadShape;
  /** Schema declares but handler never reads. */
  declaredNotRead: string[];
  /** Handler reads but schema doesn't declare. */
  readNotDeclared: string[];
  /** Schema marks required but handler never reads. */
  requiredNotRead: string[];
  /** True when the handler was located in the source. False = the probe is stale. */
  handlerFound: boolean;
  /** Any parser-level notes (passthrough, dynamic reads, etc). */
  notes: string[];
  /** Severity: info (clean), minor (one-sided drift), major (missing required read). */
  severity: 'clean' | 'minor' | 'major';
  /** One-line verdict for the report. */
  verdict: string;
}

// ============================================================================
// AST WALK
// ============================================================================

/**
 * Walk a source file's AST, find the function that matches
 * `handlerExportName`, and return the set of input-like reads from
 * its body. Handles both of:
 *
 *   export async function foo(ctx, input) { ... input.bar ... }
 *   export const foo: ToolHandler = async (_ctx, input) => { ... input.baz ... }
 *
 * as well as parameter-level destructuring:
 *
 *   export async function foo(ctx, { status, limit }: Record<string, unknown>)
 *
 * The second input parameter is located positionally (params[1]) so
 * the walker doesn't rely on the parameter being literally named
 * `input`. Some handlers use `_input`, `params`, or `args`.
 */
export function extractHandlerReadShape(
  sourceFile: ts.SourceFile,
  handlerExportName: string,
): HandlerReadShape | null {
  // Using a mutable ref object instead of a plain `let` so TypeScript
  // doesn't lose the narrowing across the forEachChild callback
  // boundary. Inside the callback, assigning to `ref.fn` keeps the
  // declared property type stable; outside, we read `ref.fn` once
  // into a local const and TS's control flow analysis is happy.
  const ref: { fn: ts.FunctionLikeDeclaration | null } = { fn: null };

  ts.forEachChild(sourceFile, (node) => {
    if (ref.fn) return;

    // Pattern 1: `export async function handlerName(...)`
    if (ts.isFunctionDeclaration(node) && node.name?.text === handlerExportName) {
      ref.fn = node;
      return;
    }

    // Pattern 2: `export const handlerName = ...` with an arrow or function body
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === handlerExportName) {
          if (decl.initializer) {
            if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) {
              ref.fn = decl.initializer;
              return;
            }
            // Pattern 3: wrapped in a cast like `const handler: ToolHandler = async (ctx, input) => ...`
            if (
              ts.isAsExpression(decl.initializer) &&
              (ts.isArrowFunction(decl.initializer.expression) || ts.isFunctionExpression(decl.initializer.expression))
            ) {
              ref.fn = decl.initializer.expression;
              return;
            }
          }
        }
      }
    }
  });

  const fn = ref.fn;
  if (!fn) return null;

  const shape: HandlerReadShape = {
    readKeys: new Set(),
    dynamicRead: false,
    spreadRead: false,
    passthroughRead: false,
  };

  // The "input" parameter is positionally the second (after ctx).
  // Some handlers have only one param; skip in that case.
  const inputParam = fn.parameters[1];
  if (!inputParam) return shape;

  // Case A: destructured parameter — `function h(ctx, { foo, bar })`
  if (ts.isObjectBindingPattern(inputParam.name)) {
    for (const element of inputParam.name.elements) {
      if (ts.isBindingElement(element) && ts.isIdentifier(element.name)) {
        // If the element has a propertyName (aliased), that's the
        // key we care about; otherwise the name IS the key.
        const key = element.propertyName && ts.isIdentifier(element.propertyName)
          ? element.propertyName.text
          : element.name.text;
        shape.readKeys.add(key);
      }
    }
    // A destructured parameter binds to its keys directly; no
    // further `input.X` reads are possible through a named ref.
    // Walk anyway in case the body does something weird, but don't
    // rely on it.
  }

  // Case B: named parameter — walk the body for `<name>.X` reads
  let inputParamName: string | null = null;
  if (ts.isIdentifier(inputParam.name)) {
    inputParamName = inputParam.name.text;
  }

  // Walk the function body collecting reads keyed to `inputParamName`.
  // Also collect reads from any shadow `input` identifiers inside
  // the body, since some handlers reassign via `const input = ...`
  // later on. We track every identifier whose initializer was the
  // original parameter or a destructuring.
  const aliases = new Set<string>();
  if (inputParamName) aliases.add(inputParamName);

  /**
   * Strip type assertions so `input as Foo` / `<Foo>input` are
   * treated the same as a bare `input` identifier when we check
   * whether a destructuring initializer points at an alias. Without
   * this the walker missed handlers written as
   * `const { chat_id } = input as { chat_id: string }` — which is
   * the idiomatic shape across every whatsapp/telegram handler in
   * the codebase.
   */
  const unwrapAssertions = (expr: ts.Expression): ts.Expression => {
    let current: ts.Expression = expr;
    while (true) {
      if (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)) {
        current = current.expression;
        continue;
      }
      if (ts.isParenthesizedExpression(current)) {
        current = current.expression;
        continue;
      }
      if (ts.isNonNullExpression(current)) {
        current = current.expression;
        continue;
      }
      return current;
    }
  };

  const visit = (node: ts.Node): void => {
    // `const X = input` / `const X = <alias>` / `const X = input as T`
    // — X becomes an alias for the same read-target.
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const init = unwrapAssertions(node.initializer);
      if (ts.isIdentifier(init) && aliases.has(init.text) && ts.isIdentifier(node.name)) {
        aliases.add(node.name.text);
      }
    }

    // `const { foo, bar } = input` / `const { foo } = input as T` —
    // binding pattern against an aliased input.
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer
    ) {
      const init = unwrapAssertions(node.initializer);
      if (ts.isIdentifier(init) && aliases.has(init.text)) {
        for (const element of node.name.elements) {
          if (ts.isBindingElement(element) && ts.isIdentifier(element.name)) {
            const key = element.propertyName && ts.isIdentifier(element.propertyName)
              ? element.propertyName.text
              : element.name.text;
            shape.readKeys.add(key);
          }
        }
      }
    }

    // `input.foo` (also handles `(input as Foo).foo` and `input!.foo`)
    if (ts.isPropertyAccessExpression(node)) {
      const base = unwrapAssertions(node.expression);
      if (ts.isIdentifier(base) && aliases.has(base.text) && ts.isIdentifier(node.name)) {
        shape.readKeys.add(node.name.text);
      }
    }

    // `input['foo']` or `input["foo"]` (also through cast unwrapping)
    if (ts.isElementAccessExpression(node)) {
      const base = unwrapAssertions(node.expression);
      if (ts.isIdentifier(base) && aliases.has(base.text)) {
        if (ts.isStringLiteral(node.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(node.argumentExpression)) {
          shape.readKeys.add(node.argumentExpression.text);
        } else {
          // Dynamic key — we can't resolve it statically
          shape.dynamicRead = true;
        }
      }
    }

    // `{ ...input }` — spread assignment. Every key of input is
    // effectively read, so suppress the declared_not_read findings.
    if (ts.isSpreadAssignment(node)) {
      const base = unwrapAssertions(node.expression);
      if (ts.isIdentifier(base) && aliases.has(base.text)) {
        shape.spreadRead = true;
      }
    }
    if (ts.isSpreadElement(node)) {
      const base = unwrapAssertions(node.expression);
      if (ts.isIdentifier(base) && aliases.has(base.text)) {
        shape.spreadRead = true;
      }
    }

    // `someFn(input)` — the whole input is passed through.
    if (ts.isCallExpression(node)) {
      for (const arg of node.arguments) {
        const base = unwrapAssertions(arg);
        if (ts.isIdentifier(base) && aliases.has(base.text)) {
          shape.passthroughRead = true;
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  if (fn.body) visit(fn.body);

  return shape;
}

// ============================================================================
// AUDIT
// ============================================================================

/**
 * Run the audit for a single tool. Opens the handler file, walks it,
 * compares reads to declared schema properties, returns a structured
 * result.
 */
export function auditHandler(input: HandlerAuditInput): HandlerAuditResult {
  const { tool, schemaProperties, schemaRequired, handlerFile, handlerExportName } = input;
  const notes: string[] = [];

  let source: string;
  try {
    source = readFileSync(handlerFile, 'utf-8');
  } catch (err) {
    return {
      tool,
      handlerFile,
      handlerExportName,
      shape: { readKeys: new Set(), dynamicRead: false, spreadRead: false, passthroughRead: false },
      declaredNotRead: [],
      readNotDeclared: [],
      requiredNotRead: [],
      handlerFound: false,
      notes: [`source file not readable: ${err instanceof Error ? err.message : String(err)}`],
      severity: 'minor',
      verdict: `skip: ${tool} handler source not readable`,
    };
  }

  const sourceFile = ts.createSourceFile(handlerFile, source, ts.ScriptTarget.Latest, true);
  const shape = extractHandlerReadShape(sourceFile, handlerExportName);

  if (!shape) {
    return {
      tool,
      handlerFile,
      handlerExportName,
      shape: { readKeys: new Set(), dynamicRead: false, spreadRead: false, passthroughRead: false },
      declaredNotRead: [],
      readNotDeclared: [],
      requiredNotRead: [],
      handlerFound: false,
      notes: [`export ${handlerExportName} not found in ${handlerFile}`],
      severity: 'minor',
      verdict: `skip: ${tool} handler export ${handlerExportName} not found`,
    };
  }

  const declaredSet = new Set(schemaProperties);
  const requiredSet = new Set(schemaRequired);
  const readSet = shape.readKeys;

  // If the handler spreads or passes through `input`, every declared
  // key is effectively read. Suppress the declared_not_read finding.
  const allDeclaredTreatedAsRead = shape.spreadRead || shape.passthroughRead;

  const declaredNotRead = allDeclaredTreatedAsRead
    ? []
    : schemaProperties.filter((p) => !readSet.has(p));

  const readNotDeclared = [...readSet].filter((k) => !declaredSet.has(k));

  const requiredNotRead = schemaRequired.filter((r) => !readSet.has(r) && !allDeclaredTreatedAsRead);

  if (shape.dynamicRead) {
    notes.push('handler has dynamic input[...] access; some reads may not be statically visible');
  }
  if (shape.spreadRead) {
    notes.push('handler spreads the entire input object; every declared property is effectively read');
  }
  if (shape.passthroughRead) {
    notes.push('handler passes the whole input object to a helper; declared_not_read findings suppressed');
  }

  // Severity:
  //   major  = required_not_read (the model WILL trip this)
  //   minor  = any other drift
  //   clean  = no drift at all
  let severity: HandlerAuditResult['severity'] = 'clean';
  if (requiredNotRead.length > 0) severity = 'major';
  else if (declaredNotRead.length > 0 || readNotDeclared.length > 0) severity = 'minor';

  // Verdict string for the report
  let verdict: string;
  if (severity === 'clean') {
    verdict = `OK: ${tool} reads ${readSet.size}/${declaredSet.size} declared props cleanly`;
  } else {
    const parts: string[] = [];
    if (requiredNotRead.length > 0) parts.push(`REQUIRED-NOT-READ: ${requiredNotRead.join(', ')}`);
    if (declaredNotRead.length > 0) parts.push(`declared_not_read: ${declaredNotRead.join(', ')}`);
    if (readNotDeclared.length > 0) parts.push(`read_not_declared: ${readNotDeclared.join(', ')}`);
    verdict = `${severity.toUpperCase()}: ${tool} — ${parts.join(' | ')}`;
  }

  return {
    tool,
    handlerFile,
    handlerExportName,
    shape,
    declaredNotRead,
    readNotDeclared,
    requiredNotRead,
    handlerFound: true,
    notes,
    severity,
    verdict,
  };
}

// ============================================================================
// BATCH AUDIT + REPORT
// ============================================================================

export interface AuditRunResult {
  startedAt: string;
  finishedAt: string;
  results: HandlerAuditResult[];
  summary: {
    total: number;
    clean: number;
    minor: number;
    major: number;
    skipped: number;
  };
}

export function runAudit(inputs: HandlerAuditInput[]): AuditRunResult {
  const startedAt = new Date().toISOString();
  const results = inputs.map(auditHandler);
  const finishedAt = new Date().toISOString();
  return {
    startedAt,
    finishedAt,
    results,
    summary: {
      total: results.length,
      clean: results.filter((r) => r.severity === 'clean' && r.handlerFound).length,
      minor: results.filter((r) => r.severity === 'minor' && r.handlerFound).length,
      major: results.filter((r) => r.severity === 'major' && r.handlerFound).length,
      skipped: results.filter((r) => !r.handlerFound).length,
    },
  };
}

export function formatAuditReport(run: AuditRunResult): string {
  const lines: string[] = [];
  lines.push(
    `schema↔handler audit — ${run.summary.total} tools, ` +
    `${run.summary.major} major / ${run.summary.minor} minor / ` +
    `${run.summary.clean} clean / ${run.summary.skipped} skipped`,
  );
  lines.push('');
  // Group by severity: major first, minor next, clean last, skips at the end
  const order = (r: HandlerAuditResult): number => {
    if (!r.handlerFound) return 3;
    if (r.severity === 'major') return 0;
    if (r.severity === 'minor') return 1;
    return 2;
  };
  const sorted = [...run.results].sort((a, b) => order(a) - order(b));
  for (const r of sorted) {
    const tag = !r.handlerFound ? '⚪' : r.severity === 'major' ? '🔴' : r.severity === 'minor' ? '🟡' : '🟢';
    lines.push(`${tag} ${r.verdict}`);
    for (const note of r.notes) lines.push(`    note: ${note}`);
  }
  return lines.join('\n');
}
