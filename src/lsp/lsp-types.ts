/**
 * LSP types, interfaces, and language server specifications.
 */

export type LspLanguage = 'typescript' | 'python' | 'go' | 'rust';

export interface LspServerSpec {
  language: LspLanguage;
  command: string;
  args: string[];
  extensions: string[];
  installHint: string;
}

export interface LspPosition {
  /** 0-based line number (LSP convention) */
  line: number;
  /** 0-based character offset (LSP convention) */
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspDiagnostic {
  range: LspRange;
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  source?: string;
  code?: string | number;
}

export interface LspHoverResult {
  contents: string;
  range?: LspRange;
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}

export interface LspCompletionItem {
  label: string;
  kind?: string;
  detail?: string;
}

const COMPLETION_KIND_MAP: Record<number, string> = {
  1: 'text', 2: 'method', 3: 'function', 4: 'constructor', 5: 'field',
  6: 'variable', 7: 'class', 8: 'interface', 9: 'module', 10: 'property',
  11: 'unit', 12: 'value', 13: 'enum', 14: 'keyword', 15: 'snippet',
  16: 'color', 17: 'file', 18: 'reference', 19: 'folder', 20: 'enum_member',
  21: 'constant', 22: 'struct', 23: 'event', 24: 'operator', 25: 'type_param',
};

export function completionKindToString(kind?: number): string | undefined {
  if (kind === undefined) return undefined;
  return COMPLETION_KIND_MAP[kind] ?? 'unknown';
}

const SEVERITY_MAP: Record<number, LspDiagnostic['severity']> = {
  1: 'error', 2: 'warning', 3: 'info', 4: 'hint',
};

export function diagnosticSeverityToString(severity?: number): LspDiagnostic['severity'] {
  return severity ? (SEVERITY_MAP[severity] ?? 'info') : 'info';
}

/** Hardcoded language server specifications for supported languages. */
export const LSP_SERVER_SPECS: Record<LspLanguage, LspServerSpec> = {
  typescript: {
    language: 'typescript',
    command: 'typescript-language-server',
    args: ['--stdio'],
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
    installHint: 'npm install -g typescript-language-server typescript',
  },
  python: {
    language: 'python',
    command: 'pylsp',
    args: [],
    extensions: ['.py'],
    installHint: 'pip install python-lsp-server',
  },
  go: {
    language: 'go',
    command: 'gopls',
    args: ['serve'],
    extensions: ['.go'],
    installHint: 'go install golang.org/x/tools/gopls@latest',
  },
  rust: {
    language: 'rust',
    command: 'rust-analyzer',
    args: [],
    extensions: ['.rs'],
    installHint: 'rustup component add rust-analyzer',
  },
};

/** Detect language from file extension. Returns null for unsupported files. */
export function detectLanguage(filePath: string): LspLanguage | null {
  const ext = filePath.slice(filePath.lastIndexOf('.'));
  for (const [lang, spec] of Object.entries(LSP_SERVER_SPECS)) {
    if (spec.extensions.includes(ext)) return lang as LspLanguage;
  }
  return null;
}
