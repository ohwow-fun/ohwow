/**
 * LSP server auto-detection and installation.
 * Follows the internet-installer.ts pattern: check command existence, attempt auto-install.
 */

import { execSync } from 'child_process';
import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from '../lib/logger.js';
import type { LspLanguage } from './lsp-types.js';
import { LSP_SERVER_SPECS } from './lsp-types.js';

const FLAG_DIR = join(homedir(), '.ohwow');

function flagPath(language: LspLanguage): string {
  return join(FLAG_DIR, `lsp-${language}-installed`);
}

function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: 'pipe', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/** Check if the language server binary for a language is available. */
export function isLspServerAvailable(language: LspLanguage): boolean {
  const spec = LSP_SERVER_SPECS[language];
  return commandExists(spec.command);
}

/**
 * Ensure the LSP server for a language is installed.
 * Returns true if available (either already installed or successfully auto-installed).
 * Returns false with no side effects if auto-install fails.
 */
export async function ensureLspServer(language: LspLanguage): Promise<boolean> {
  const spec = LSP_SERVER_SPECS[language];

  // Already available
  if (commandExists(spec.command)) return true;

  // Already tried and failed
  if (existsSync(flagPath(language))) return false;

  logger.info({ language, command: spec.command }, '[LSP] Attempting auto-install');

  try {
    switch (language) {
      case 'typescript':
        execSync('npm install -g typescript-language-server typescript', {
          stdio: 'pipe', timeout: 60_000,
        });
        break;
      case 'python':
        try {
          execSync('pip3 install python-lsp-server', { stdio: 'pipe', timeout: 60_000 });
        } catch {
          execSync('pip install python-lsp-server', { stdio: 'pipe', timeout: 60_000 });
        }
        break;
      case 'go':
        execSync('go install golang.org/x/tools/gopls@latest', { stdio: 'pipe', timeout: 120_000 });
        break;
      case 'rust':
        execSync('rustup component add rust-analyzer', { stdio: 'pipe', timeout: 60_000 });
        break;
    }

    if (commandExists(spec.command)) {
      logger.info({ language }, '[LSP] Auto-install succeeded');
      return true;
    }
  } catch (err) {
    logger.warn({ language, err }, '[LSP] Auto-install failed');
  }

  // Write flag to avoid retrying
  try {
    writeFileSync(flagPath(language), `Install failed at ${new Date().toISOString()}\nRun: ${spec.installHint}\n`);
  } catch {
    // Non-critical
  }

  return false;
}
