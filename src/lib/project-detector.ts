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

function tryReadJson(filePath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function tryReadText(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

// ── Node / Deno / Bun ──────────────────────────────────────────────────────

function detectNodeProject(dir: string): ProjectStack | null {
  // Check for Deno first (deno.json/deno.jsonc)
  const denoConfig = tryReadJson(join(dir, 'deno.json')) || tryReadJson(join(dir, 'deno.jsonc'));
  if (denoConfig) {
    const tasks = (denoConfig.tasks || {}) as Record<string, string>;
    return {
      type: 'deno',
      name: denoConfig.name as string | undefined,
      testCommand: tasks.test ? 'deno task test' : 'deno test',
      lintCommand: 'deno lint',
    };
  }

  // Check for Bun (bunfig.toml)
  const hasBunConfig = existsSync(join(dir, 'bunfig.toml'));
  const hasBunLock = existsSync(join(dir, 'bun.lockb')) || existsSync(join(dir, 'bun.lock'));

  const pkg = tryReadJson(join(dir, 'package.json'));
  if (!pkg) return null;

  const scripts = (pkg.scripts || {}) as Record<string, string>;
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) } as Record<string, string>;

  // Detect the package manager (for command prefixes)
  const isBun = hasBunConfig || hasBunLock;
  const pm = isBun ? 'bun' : 'npm';

  // Framework detection — ordered from most specific to most generic
  let framework: string | undefined;
  if (deps.next) framework = 'next';
  else if (deps.nuxt) framework = 'nuxt';
  else if (deps.remix || deps['@remix-run/node']) framework = 'remix';
  else if (deps.astro) framework = 'astro';
  else if (deps['@sveltejs/kit']) framework = 'sveltekit';
  else if (deps.svelte) framework = 'svelte';
  else if (deps['@angular/core']) framework = 'angular';
  else if (deps.gatsby) framework = 'gatsby';
  else if (deps.solid || deps['solid-js']) framework = 'solid';
  else if (deps.preact) framework = 'preact';
  else if (deps.qwik || deps['@builder.io/qwik']) framework = 'qwik';
  else if (deps.hono) framework = 'hono';
  else if (deps.fastify) framework = 'fastify';
  else if (deps.express) framework = 'express';
  else if (deps.nest || deps['@nestjs/core']) framework = 'nest';
  else if (deps.vite) framework = 'vite';
  else if (deps.esbuild) framework = 'esbuild';
  else if (deps.react) framework = 'react';
  else if (deps.vue) framework = 'vue';

  return {
    type: isBun ? 'bun' : 'node',
    name: pkg.name as string | undefined,
    framework,
    testCommand: scripts.test ? `${pm} test` : scripts['test:unit'] ? `${pm} run test:unit` : undefined,
    buildCommand: scripts.build ? `${pm} run build` : undefined,
    lintCommand: scripts.lint
      ? `${pm} run lint`
      : scripts.typecheck
        ? `${pm} run typecheck`
        : deps.typescript ? `npx tsc --noEmit` : undefined,
  };
}

// ── Rust ────────────────────────────────────────────────────────────────────

function detectRustProject(dir: string): ProjectStack | null {
  const content = tryReadText(join(dir, 'Cargo.toml'));
  if (!content) return null;

  let name: string | undefined;
  const nameMatch = content.match(/^name\s*=\s*"([^"]+)"/m);
  if (nameMatch) name = nameMatch[1];

  // Detect framework from dependencies
  let framework: string | undefined;
  if (content.includes('actix-web')) framework = 'actix';
  else if (content.includes('axum')) framework = 'axum';
  else if (content.includes('rocket')) framework = 'rocket';
  else if (content.includes('warp')) framework = 'warp';
  else if (content.includes('tauri')) framework = 'tauri';
  else if (content.includes('leptos')) framework = 'leptos';
  else if (content.includes('yew')) framework = 'yew';

  return {
    type: 'rust',
    name,
    framework,
    testCommand: 'cargo test',
    buildCommand: 'cargo build',
    lintCommand: 'cargo clippy',
  };
}

// ── Python ──────────────────────────────────────────────────────────────────

function detectPythonProject(dir: string): ProjectStack | null {
  const pyproject = tryReadText(join(dir, 'pyproject.toml'));
  const hasSetupPy = existsSync(join(dir, 'setup.py'));
  const hasRequirements = existsSync(join(dir, 'requirements.txt'));

  if (!pyproject && !hasSetupPy && !hasRequirements) return null;

  let framework: string | undefined;
  let name: string | undefined;

  if (pyproject) {
    const nameMatch = pyproject.match(/^name\s*=\s*"([^"]+)"/m);
    if (nameMatch) name = nameMatch[1];

    if (pyproject.includes('django')) framework = 'django';
    else if (pyproject.includes('fastapi')) framework = 'fastapi';
    else if (pyproject.includes('flask')) framework = 'flask';
    else if (pyproject.includes('starlette')) framework = 'starlette';
    else if (pyproject.includes('litestar')) framework = 'litestar';
    else if (pyproject.includes('streamlit')) framework = 'streamlit';
    else if (pyproject.includes('gradio')) framework = 'gradio';
  }

  // Detect test runner
  let testCommand = 'python -m pytest';
  if (pyproject) {
    if (pyproject.includes('[tool.pytest]') || pyproject.includes('pytest')) testCommand = 'pytest';
    if (pyproject.includes('poetry')) testCommand = 'poetry run pytest';
    if (pyproject.includes('[tool.pdm]')) testCommand = 'pdm run pytest';
  }

  // Detect linter
  let lintCommand = 'ruff check .';
  if (pyproject) {
    if (pyproject.includes('[tool.mypy]')) lintCommand = 'mypy . && ruff check .';
    else if (pyproject.includes('pyright')) lintCommand = 'pyright && ruff check .';
  }

  return {
    type: 'python',
    name,
    framework,
    testCommand,
    lintCommand,
  };
}

// ── Go ──────────────────────────────────────────────────────────────────────

function detectGoProject(dir: string): ProjectStack | null {
  const content = tryReadText(join(dir, 'go.mod'));
  if (!content) return null;

  let name: string | undefined;
  const moduleMatch = content.match(/^module\s+(\S+)/m);
  if (moduleMatch) name = moduleMatch[1];

  // Detect framework
  let framework: string | undefined;
  if (content.includes('github.com/gin-gonic/gin')) framework = 'gin';
  else if (content.includes('github.com/gofiber/fiber')) framework = 'fiber';
  else if (content.includes('github.com/labstack/echo')) framework = 'echo';
  else if (content.includes('github.com/gorilla/mux')) framework = 'gorilla';
  else if (content.includes('connectrpc.com')) framework = 'connect';

  return {
    type: 'go',
    name,
    framework,
    testCommand: 'go test ./...',
    buildCommand: 'go build ./...',
    lintCommand: 'golangci-lint run',
  };
}

// ── Ruby ────────────────────────────────────────────────────────────────────

function detectRubyProject(dir: string): ProjectStack | null {
  const gemfile = tryReadText(join(dir, 'Gemfile'));
  if (!gemfile) return null;

  let framework: string | undefined;
  let name: string | undefined;

  if (gemfile.includes("'rails'") || gemfile.includes('"rails"')) framework = 'rails';
  else if (gemfile.includes("'sinatra'") || gemfile.includes('"sinatra"')) framework = 'sinatra';
  else if (gemfile.includes("'hanami'") || gemfile.includes('"hanami"')) framework = 'hanami';

  // Try to get name from gemspec
  const gemspecs = ['*.gemspec'].flatMap(() => {
    try {
      const content = tryReadText(join(dir, 'Gemfile'));
      const nameMatch = content?.match(/spec\.name\s*=\s*['"]([^'"]+)['"]/);
      return nameMatch ? [nameMatch[1]] : [];
    } catch { return []; }
  });
  if (gemspecs.length > 0) name = gemspecs[0];

  return {
    type: 'ruby',
    name,
    framework,
    testCommand: framework === 'rails' ? 'bundle exec rails test' : 'bundle exec rspec',
    buildCommand: undefined,
    lintCommand: 'bundle exec rubocop',
  };
}

// ── PHP ─────────────────────────────────────────────────────────────────────

function detectPhpProject(dir: string): ProjectStack | null {
  const composer = tryReadJson(join(dir, 'composer.json'));
  if (!composer) return null;

  const require = (composer.require || {}) as Record<string, string>;

  let framework: string | undefined;
  if (require['laravel/framework']) framework = 'laravel';
  else if (require['symfony/framework-bundle']) framework = 'symfony';

  return {
    type: 'php',
    name: composer.name as string | undefined,
    framework,
    testCommand: 'vendor/bin/phpunit',
    lintCommand: 'vendor/bin/phpstan analyse',
  };
}

// ── Java / Kotlin ───────────────────────────────────────────────────────────

function detectJvmProject(dir: string): ProjectStack | null {
  // Gradle (Kotlin or Groovy)
  const hasGradle = existsSync(join(dir, 'build.gradle')) || existsSync(join(dir, 'build.gradle.kts'));
  if (hasGradle) {
    const gradleContent = tryReadText(join(dir, 'build.gradle.kts')) || tryReadText(join(dir, 'build.gradle'));
    let framework: string | undefined;
    if (gradleContent) {
      if (gradleContent.includes('spring-boot')) framework = 'spring';
      else if (gradleContent.includes('ktor')) framework = 'ktor';
      else if (gradleContent.includes('micronaut')) framework = 'micronaut';
    }
    const isKotlin = existsSync(join(dir, 'build.gradle.kts')) || gradleContent?.includes('kotlin');
    return {
      type: isKotlin ? 'kotlin' : 'java',
      framework,
      testCommand: './gradlew test',
      buildCommand: './gradlew build',
    };
  }

  // Maven
  if (existsSync(join(dir, 'pom.xml'))) {
    const pomContent = tryReadText(join(dir, 'pom.xml'));
    let framework: string | undefined;
    if (pomContent?.includes('spring-boot')) framework = 'spring';
    return {
      type: 'java',
      framework,
      testCommand: 'mvn test',
      buildCommand: 'mvn package',
    };
  }

  return null;
}

// ── Elixir ──────────────────────────────────────────────────────────────────

function detectElixirProject(dir: string): ProjectStack | null {
  const mixContent = tryReadText(join(dir, 'mix.exs'));
  if (!mixContent) return null;

  let framework: string | undefined;
  let name: string | undefined;

  const nameMatch = mixContent.match(/app:\s*:(\w+)/);
  if (nameMatch) name = nameMatch[1];

  if (mixContent.includes(':phoenix')) framework = 'phoenix';
  else if (mixContent.includes(':plug')) framework = 'plug';

  return {
    type: 'elixir',
    name,
    framework,
    testCommand: 'mix test',
    buildCommand: 'mix compile',
    lintCommand: 'mix credo',
  };
}

// ── .NET (C#/F#) ────────────────────────────────────────────────────────────

function detectDotnetProject(dir: string): ProjectStack | null {
  // Look for .csproj or .fsproj
  const csproj = existsSync(join(dir, '*.csproj'));
  const hasSln = existsSync(join(dir, '*.sln'));

  // Simpler: check for global.json or a known .NET structure
  if (!existsSync(join(dir, 'global.json')) && !csproj && !hasSln) {
    // Try directory scan for any .csproj/.fsproj
    try {
      const files = readFileSync(join(dir, '.'), 'utf-8');
      if (!files) return null;
    } catch {
      // Check for common .NET entry points
      const hasProgram = existsSync(join(dir, 'Program.cs')) || existsSync(join(dir, 'Program.fs'));
      if (!hasProgram) return null;
    }
  }

  return {
    type: 'dotnet',
    testCommand: 'dotnet test',
    buildCommand: 'dotnet build',
  };
}

// ── Swift ───────────────────────────────────────────────────────────────────

function detectSwiftProject(dir: string): ProjectStack | null {
  const content = tryReadText(join(dir, 'Package.swift'));
  if (!content) return null;

  let name: string | undefined;
  const nameMatch = content.match(/name:\s*"([^"]+)"/);
  if (nameMatch) name = nameMatch[1];

  return {
    type: 'swift',
    name,
    testCommand: 'swift test',
    buildCommand: 'swift build',
  };
}

// ── Zig ─────────────────────────────────────────────────────────────────────

function detectZigProject(dir: string): ProjectStack | null {
  if (!existsSync(join(dir, 'build.zig'))) return null;

  return {
    type: 'zig',
    testCommand: 'zig build test',
    buildCommand: 'zig build',
  };
}

// ── Main Detector ───────────────────────────────────────────────────────────

/** Detect the project stack from manifest files in the given directory. */
export function detectProjectStack(dir: string): ProjectStack | null {
  // Try each detector in order of specificity
  return detectNodeProject(dir)
    || detectRustProject(dir)
    || detectPythonProject(dir)
    || detectGoProject(dir)
    || detectRubyProject(dir)
    || detectPhpProject(dir)
    || detectJvmProject(dir)
    || detectElixirProject(dir)
    || detectDotnetProject(dir)
    || detectSwiftProject(dir)
    || detectZigProject(dir)
    || null;
}
