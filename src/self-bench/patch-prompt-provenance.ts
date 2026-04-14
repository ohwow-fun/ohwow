/**
 * Layer 8 of the autonomous-fixing safety floor — provenance-locked
 * patch prompts.
 *
 * Every input to a patch-authoring prompt must declare where it came
 * from. Only four sources are authoritative: a self_findings row, a
 * source file read from disk, a test file read from disk, or a
 * self-bench registry. LLM outputs from other runs, agent chat
 * messages, and prose narratives are rejected — those are the classic
 * vectors for a hallucinated proposal to feed itself into its own
 * prompt and produce drift-amplified patches.
 *
 * Ships as a pure library; the proposal pipeline will call
 * validateProvenanceInputs + buildProvenancePrompt once a tier-2
 * patch flow actually exists. Until then this module is unused but
 * present so the surface is stable when the pipeline wires up.
 */

import fs from 'node:fs';
import path from 'node:path';

export type ProvenanceSource =
  | 'finding'
  | 'source-file'
  | 'test-file'
  | 'registry';

const FORBIDDEN_SOURCES = new Set([
  'llm-call',
  'agent-message',
  'chat-transcript',
  'agent-output',
  'proposal-history',
]);

export interface ProvenanceInput {
  /** Where this content came from. Must be in the allowlist above. */
  source: ProvenanceSource;
  /**
   * Concrete identifier: uuid for findings, relative path for source /
   * test files, registry module path for registries. Non-empty.
   */
  ref: string;
  /** The actual text content that will land in the prompt. Non-empty. */
  content: string;
}

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

const ALLOWED_SOURCES: ReadonlySet<ProvenanceSource> = new Set([
  'finding',
  'source-file',
  'test-file',
  'registry',
]);

/**
 * Validate a list of provenance inputs against the allowlist and
 * (for file-backed sources) against disk. Returns the first failure.
 * Callers pass repoRoot so file-backed refs are resolved against
 * the active workspace's tree, not process.cwd().
 */
export function validateProvenanceInputs(
  inputs: readonly ProvenanceInput[],
  repoRoot: string,
): ValidationResult {
  if (inputs.length === 0) {
    return { ok: false, reason: 'no provenance inputs supplied' };
  }
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    const label = `input[${i}]`;

    // Reject explicitly blocked sources before the allowlist check
    // so refusal messages are more specific when a caller hands in
    // a known-bad source name.
    if (FORBIDDEN_SOURCES.has(input.source as string)) {
      return {
        ok: false,
        reason: `${label}: source '${input.source}' is forbidden (LLM outputs and agent messages cannot seed patch prompts)`,
      };
    }
    if (!ALLOWED_SOURCES.has(input.source)) {
      return {
        ok: false,
        reason: `${label}: source '${input.source}' is not in the provenance allowlist`,
      };
    }
    if (typeof input.ref !== 'string' || input.ref.length === 0) {
      return { ok: false, reason: `${label}: ref must be a non-empty string` };
    }
    if (typeof input.content !== 'string' || input.content.length === 0) {
      return { ok: false, reason: `${label}: content must be a non-empty string` };
    }

    if (input.source === 'source-file' || input.source === 'test-file') {
      const verification = verifyFileContent(input, repoRoot, label);
      if (!verification.ok) return verification;
    }
  }
  return { ok: true };
}

function verifyFileContent(
  input: ProvenanceInput,
  repoRoot: string,
  label: string,
): ValidationResult {
  // Defensive path checks — the same ones safeSelfCommit uses.
  if (input.ref.includes('..') || path.isAbsolute(input.ref)) {
    return {
      ok: false,
      reason: `${label}: ref '${input.ref}' must be a relative path with no traversal`,
    };
  }
  const abs = path.join(repoRoot, input.ref);
  let onDisk: string;
  try {
    onDisk = fs.readFileSync(abs, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: `${label}: could not read ${input.ref}: ${msg}`,
    };
  }
  if (onDisk !== input.content) {
    return {
      ok: false,
      reason: `${label}: content for ${input.ref} does not match disk (prompt is claiming the file says something it doesn't)`,
    };
  }
  return { ok: true };
}

/**
 * Assemble a provenance-tagged prompt body. Each input becomes a
 * <source="..." ref="..."> block so the author model sees the
 * structure instead of free-running prose. Callers wrap this body
 * with whatever instruction prefix the patch task needs.
 */
export function buildProvenancePrompt(
  inputs: readonly ProvenanceInput[],
): string {
  const blocks = inputs.map((input) => {
    return `<source name="${input.source}" ref="${escapeAttr(input.ref)}">\n${input.content}\n</source>`;
  });
  return blocks.join('\n\n');
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;');
}
