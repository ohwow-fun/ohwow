/**
 * Layer 4 of the autonomous-fixing safety floor — AST-bounded patch
 * surface.
 *
 * Every file safeSelfCommit MODIFIES (as opposed to creates new) must
 * have at most ONE top-level symbol whose text changed. This stops a
 * hallucinated patch from sweeping through an existing file rewriting
 * unrelated declarations — the autonomous fixer gets one symbol's
 * worth of blast radius per commit, and nothing more.
 *
 * Why top-level symbols
 * ---------------------
 * Top-level declarations are the vocabulary a reviewer thinks in:
 * "the FooService class changed," "the BAR_CONSTANT changed," "a new
 * import was added." Counting changes at that granularity makes the
 * gate's failure mode legible — the refusal message names exactly
 * which declarations the patch touched. Sub-statement-level diffing
 * would produce refusal reasons no one can act on.
 *
 * What counts as one top-level symbol
 * -----------------------------------
 * Any direct child of SourceFile: function decl, class decl,
 * variable statement, type alias, interface, enum, import decl,
 * export decl/assignment. Names are extracted when possible; when
 * not (e.g. a bare `export * from './x.js'`), a synthetic name based
 * on node kind + position is used so changes still register.
 *
 * How change is detected
 * ----------------------
 * Build a map {name -> normalized text} for each side. A symbol is
 * considered changed if:
 *   - it exists on one side but not the other (added or deleted)
 *   - its normalized text differs between sides
 * Pure whitespace-between-declarations edits don't count because
 * only declaration text is compared, not the gaps.
 *
 * Creates vs. modifies
 * --------------------
 * This module is only invoked on modify paths. A brand-new file has
 * no "prior" AST to diff against and is allowed any structure it
 * needs — the new-file-only allowlist already bounds what paths can
 * receive a new file.
 */

import ts from 'typescript';

export interface TopLevelDiff {
  /** Names (or synthetic keys) of symbols that appear only in the new source. */
  added: string[];
  /** Names (or synthetic keys) of symbols that appear only in the old source. */
  removed: string[];
  /** Names of symbols present in both but whose normalized text differs. */
  modified: string[];
}

export function diffTopLevelSymbols(
  oldSource: string,
  newSource: string,
): TopLevelDiff {
  const oldMap = topLevelSymbolMap(oldSource);
  const newMap = topLevelSymbolMap(newSource);

  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];

  for (const [name, text] of newMap) {
    if (!oldMap.has(name)) {
      added.push(name);
    } else if (oldMap.get(name) !== text) {
      modified.push(name);
    }
  }
  for (const name of oldMap.keys()) {
    if (!newMap.has(name)) removed.push(name);
  }
  return { added, removed, modified };
}

/**
 * Returns the combined set of symbol names affected by the diff.
 * A patch is considered to touch N symbols iff this list has length N.
 */
export function changedSymbolCount(diff: TopLevelDiff): number {
  return diff.added.length + diff.removed.length + diff.modified.length;
}

function topLevelSymbolMap(source: string): Map<string, string> {
  const sf = ts.createSourceFile(
    'tmp.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const map = new Map<string, string>();
  for (const stmt of sf.statements) {
    for (const [name, text] of namedSymbolsOf(stmt, sf)) {
      map.set(name, text);
    }
  }
  return map;
}

/**
 * One top-level statement may produce multiple symbols (e.g. a
 * `const a = 1, b = 2;` VariableStatement has two declarations).
 * We treat each named declaration as its own symbol so a patch
 * touching only `a` is not conflated with one also touching `b`.
 * Bare re-exports and side-effect imports fall back to a
 * kind+position key so they still register as changes.
 */
function namedSymbolsOf(
  stmt: ts.Statement,
  sf: ts.SourceFile,
): Array<[string, string]> {
  const normalize = (n: ts.Node) => n.getText(sf).replace(/\s+/g, ' ').trim();

  if (ts.isVariableStatement(stmt)) {
    const out: Array<[string, string]> = [];
    for (const decl of stmt.declarationList.declarations) {
      const name = declarationName(decl.name);
      if (name) out.push([`var:${name}`, normalize(decl)]);
    }
    if (out.length > 0) return out;
  }

  if (
    ts.isFunctionDeclaration(stmt) ||
    ts.isClassDeclaration(stmt) ||
    ts.isInterfaceDeclaration(stmt) ||
    ts.isTypeAliasDeclaration(stmt) ||
    ts.isEnumDeclaration(stmt) ||
    ts.isModuleDeclaration(stmt)
  ) {
    if (stmt.name) {
      return [[`${kindLabel(stmt)}:${stmt.name.getText(sf)}`, normalize(stmt)]];
    }
  }

  if (ts.isImportDeclaration(stmt)) {
    const spec = stmt.moduleSpecifier.getText(sf);
    return [[`import:${spec}`, normalize(stmt)]];
  }

  if (ts.isExportDeclaration(stmt)) {
    const spec = stmt.moduleSpecifier?.getText(sf) ?? '<local>';
    return [[`export:${spec}@${stmt.getStart()}`, normalize(stmt)]];
  }

  if (ts.isExportAssignment(stmt)) {
    return [[`export-assign@${stmt.getStart()}`, normalize(stmt)]];
  }

  // Fallback: use kind + position so we still catch changes to
  // otherwise-unnameable top-level statements.
  return [[`stmt:${stmt.kind}@${stmt.getStart()}`, normalize(stmt)]];
}

function declarationName(node: ts.BindingName): string | null {
  if (ts.isIdentifier(node)) return node.text;
  return null;
}

function kindLabel(stmt: ts.Statement): string {
  if (ts.isFunctionDeclaration(stmt)) return 'fn';
  if (ts.isClassDeclaration(stmt)) return 'class';
  if (ts.isInterfaceDeclaration(stmt)) return 'iface';
  if (ts.isTypeAliasDeclaration(stmt)) return 'type';
  if (ts.isEnumDeclaration(stmt)) return 'enum';
  if (ts.isModuleDeclaration(stmt)) return 'module';
  return 'stmt';
}
