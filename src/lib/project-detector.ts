/**
 * Project type detection for code mode.
 * Reads manifest files to determine stack, framework, and common commands.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export interface ProjectStack {
  type: string;
  name?: string;
  framework?: string;
  testCommand?: string;
  buildCommand?: string;
  lintCommand?: string;
}

function tryReadJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function detectNodeProject(dir: string): ProjectStack | null {
  const pkg = tryReadJson(join(dir, 'package.json'));
  if (!pkg) return null;

  const scripts = (pkg.scripts || {}) as Record<string, string>;
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) } as Record<string, string>;

  let framework: string | undefined;
  if (deps.next) framework = 'next';
  else if (deps.vite) framework = 'vite';
  else if (deps.remix || deps['@remix-run/node']) framework = 'remix';
  else if (deps.express) framework = 'express';
  else if (deps.fastify) framework = 'fastify';
  else if (deps.nuxt) framework = 'nuxt';
  else if (deps.svelte || deps['@sveltejs/kit']) framework = 'svelte';
  else if (deps.react) framework = 'react';
  else if (deps.vue) framework = 'vue';

  return {
    type: 'node',
    name: pkg.name as string | undefined,
    framework,
    testCommand: scripts.test ? `npm test` : scripts['test:unit'] ? `npm run test:unit` : undefined,
    buildCommand: scripts.build ? `npm run build` : undefined,
    lintCommand: scripts.lint ? `npm run lint` : scripts.typecheck ? `npm run typecheck` : undefined,
  };
}

function detectRustProject(dir: string): ProjectStack | null {
  const cargoPath = join(dir, 'Cargo.toml');
  if (!existsSync(cargoPath)) return null;

  let name: string | undefined;
  try {
    const content = readFileSync(cargoPath, 'utf-8');
    const nameMatch = content.match(/^name\s*=\s*"([^"]+)"/m);
    if (nameMatch) name = nameMatch[1];
  } catch { /* ignore */ }

  return {
    type: 'rust',
    name,
    testCommand: 'cargo test',
    buildCommand: 'cargo build',
    lintCommand: 'cargo clippy',
  };
}

function detectPythonProject(dir: string): ProjectStack | null {
  const hasPyproject = existsSync(join(dir, 'pyproject.toml'));
  const hasSetupPy = existsSync(join(dir, 'setup.py'));
  const hasRequirements = existsSync(join(dir, 'requirements.txt'));

  if (!hasPyproject && !hasSetupPy && !hasRequirements) return null;

  let framework: string | undefined;
  let name: string | undefined;

  if (hasPyproject) {
    try {
      const content = readFileSync(join(dir, 'pyproject.toml'), 'utf-8');
      const nameMatch = content.match(/^name\s*=\s*"([^"]+)"/m);
      if (nameMatch) name = nameMatch[1];
      if (content.includes('django')) framework = 'django';
      else if (content.includes('fastapi')) framework = 'fastapi';
      else if (content.includes('flask')) framework = 'flask';
    } catch { /* ignore */ }
  }

  return {
    type: 'python',
    name,
    framework,
    testCommand: hasPyproject ? 'pytest' : 'python -m pytest',
    lintCommand: 'ruff check .',
  };
}

function detectGoProject(dir: string): ProjectStack | null {
  const goModPath = join(dir, 'go.mod');
  if (!existsSync(goModPath)) return null;

  let name: string | undefined;
  try {
    const content = readFileSync(goModPath, 'utf-8');
    const moduleMatch = content.match(/^module\s+(\S+)/m);
    if (moduleMatch) name = moduleMatch[1];
  } catch { /* ignore */ }

  return {
    type: 'go',
    name,
    testCommand: 'go test ./...',
    buildCommand: 'go build ./...',
    lintCommand: 'golangci-lint run',
  };
}

/** Detect the project stack from manifest files in the given directory. */
export function detectProjectStack(dir: string): ProjectStack | null {
  // Try each detector in order of specificity
  return detectNodeProject(dir)
    || detectRustProject(dir)
    || detectPythonProject(dir)
    || detectGoProject(dir)
    || null;
}
