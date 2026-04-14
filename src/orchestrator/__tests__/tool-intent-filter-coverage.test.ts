import { describe, it, expect } from 'vitest';
import {
  ORCHESTRATOR_TOOL_DEFINITIONS,
  LSP_TOOL_DEFINITIONS,
  COS_EXTENSION_TOOL_DEFINITIONS,
  FILESYSTEM_TOOL_DEFINITIONS,
  BASH_TOOL_DEFINITIONS,
  REQUEST_FILE_ACCESS_TOOL,
} from '../tool-definitions.js';
import {
  TOOL_SECTION_MAP,
  TOOL_PRIORITY,
  ALWAYS_INCLUDED_TOOLS,
} from '../tool-intent-filter.js';
import { DOC_MOUNT_TOOL_DEFINITIONS } from '../../execution/doc-mounts/doc-mount-tools.js';
import { BROWSER_TOOL_DEFINITIONS, REQUEST_BROWSER_TOOL } from '../../execution/browser/index.js';
import { DESKTOP_TOOL_DEFINITIONS, REQUEST_DESKTOP_TOOL } from '../../execution/desktop/index.js';

// Every tool name that can realistically appear in the merged filter input
// at runtime. If a new executor module adds tools, include them here so the
// coverage assertions stay accurate.
const KNOWN_TOOL_NAMES = new Set<string>([
  ...ORCHESTRATOR_TOOL_DEFINITIONS.map((t) => t.name),
  ...LSP_TOOL_DEFINITIONS.map((t) => t.name),
  ...COS_EXTENSION_TOOL_DEFINITIONS.map((t) => t.name),
  ...FILESYSTEM_TOOL_DEFINITIONS.map((t) => t.name),
  ...BASH_TOOL_DEFINITIONS.map((t) => t.name),
  ...BROWSER_TOOL_DEFINITIONS.map((t) => t.name),
  ...DESKTOP_TOOL_DEFINITIONS.map((t) => t.name),
  ...DOC_MOUNT_TOOL_DEFINITIONS.map((t) => t.name),
  REQUEST_FILE_ACCESS_TOOL.name,
  REQUEST_BROWSER_TOOL.name,
  REQUEST_DESKTOP_TOOL.name,
]);

describe('tool-intent-filter coverage', () => {
  it('every TOOL_SECTION_MAP key names a real tool', () => {
    const unknown = Object.keys(TOOL_SECTION_MAP).filter(
      (name) => !KNOWN_TOOL_NAMES.has(name),
    );
    expect(unknown).toEqual([]);
  });

  it('every TOOL_PRIORITY key names a real tool', () => {
    const unknown = Object.keys(TOOL_PRIORITY).filter(
      (name) => !KNOWN_TOOL_NAMES.has(name),
    );
    expect(unknown).toEqual([]);
  });

  it('every ALWAYS_INCLUDED_TOOLS entry names a real tool', () => {
    const unknown = [...ALWAYS_INCLUDED_TOOLS].filter(
      (name) => !KNOWN_TOOL_NAMES.has(name),
    );
    expect(unknown).toEqual([]);
  });
});
