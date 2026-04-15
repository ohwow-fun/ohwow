/**
 * Layer 4 extension — string-literal-scoped patch surface.
 *
 * The whole-file tier-2 invariant (patch-ast-bounds.ts) caps a patch
 * at one top-level symbol. That bound is too loose for UI source
 * files like src/web/src/pages/Agents.tsx: a single JSX component
 * IS one top-level symbol, so a model could rewrite the entire
 * component and still pass. UI files need a stricter bound.
 *
 * This gate verifies that only string-literal content differs between
 * old and new source. Every other AST node — kind, child structure,
 * identifier text, numeric literal text, keyword text — must be
 * bitwise-identical. A new import, a renamed function, a flipped
 * boolean, a removed JSX attribute: all rejected. Only the text
 * INSIDE StringLiteral / NoSubstitutionTemplateLiteral / TemplateHead
 * / TemplateMiddle / TemplateTail / JsxText nodes is free to change.
 *
 * Implementation
 * --------------
 * Build a "skeleton" string from each AST by walking every node:
 *   - for a string-like node, emit a constant placeholder (contents
 *     ignored)
 *   - for every other leaf node, emit its exact source text
 *   - for every internal node, emit its SyntaxKind tag and recurse
 *
 * Skeletons must match exactly. If either parse produces syntactic
 * errors, the gate refuses. Pure side-effect-free — reads no fs, no
 * process env; safe to call inside safeSelfCommit's hot path.
 */

import ts from 'typescript';

export interface StringLiteralBoundsResult {
  ok: boolean;
  reason?: string;
}

const STRING_LIKE_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.JsxText,
]);

/**
 * Check that the only difference between `oldSource` and `newSource`
 * is the text content of string-like literal nodes. Returns ok:false
 * with a diagnostic reason when anything else changed.
 */
export function verifyOnlyStringLiteralsChanged(
  oldSource: string,
  newSource: string,
): StringLiteralBoundsResult {
  const oldParsed = parseOrError(oldSource, 'pre-write');
  if (!oldParsed.ok) return oldParsed;
  const newParsed = parseOrError(newSource, 'post-write');
  if (!newParsed.ok) return newParsed;

  const oldSkeleton = skeleton(oldParsed.sf);
  const newSkeleton = skeleton(newParsed.sf);
  if (oldSkeleton === newSkeleton) return { ok: true };

  // Find the first point of divergence to produce a useful error
  // message. Skeletons are long; a raw diff isn't readable.
  const divergence = firstDifference(oldSkeleton, newSkeleton);
  return {
    ok: false,
    reason:
      'string-literal patch gate: non-string-literal AST change detected ' +
      `(first divergence near char ${divergence}). Only StringLiteral / ` +
      'NoSubstitutionTemplateLiteral / TemplateHead|Middle|Tail / JsxText ' +
      'node text may change in this mode.',
  };
}

type ParseResult =
  | { ok: true; sf: ts.SourceFile }
  | { ok: false; reason: string };

function parseOrError(source: string, label: string): ParseResult {
  const sf = ts.createSourceFile(
    `${label}.tsx`,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  // createSourceFile records parse errors in parseDiagnostics. An
  // empty-diagnostics parse means the file is syntactically valid.
  const diags = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] })
    .parseDiagnostics;
  if (diags && diags.length > 0) {
    const first = diags[0];
    const msg = ts.flattenDiagnosticMessageText(first.messageText, '\n');
    return {
      ok: false,
      reason: `string-literal patch gate: ${label} source failed to parse — ${msg}`,
    };
  }
  return { ok: true, sf };
}

function skeleton(sf: ts.SourceFile): string {
  const parts: string[] = [];
  visit(sf, sf, parts);
  return parts.join('');
}

function visit(node: ts.Node, sf: ts.SourceFile, out: string[]): void {
  out.push('[');
  out.push(String(node.kind));
  if (STRING_LIKE_KINDS.has(node.kind)) {
    out.push(' STR');
    out.push(']');
    return;
  }
  let childCount = 0;
  ts.forEachChild(node, (child) => {
    childCount++;
    out.push(' ');
    visit(child, sf, out);
  });
  if (childCount === 0) {
    // Leaf token that isn't a string-like literal. Include its exact
    // text so identifiers, numeric literals, and keywords must match.
    out.push(' ');
    out.push(JSON.stringify(node.getText(sf)));
  }
  out.push(']');
}

function firstDifference(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return i;
  }
  return len;
}
