import { defineConfig } from 'tsup';
import type { Plugin } from 'esbuild';
import { resolve } from 'path';

// Stub out react-devtools-core (optional ink dev dependency, not needed in production)
const stubDevtools: Plugin = {
  name: 'stub-react-devtools',
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: 'react-devtools-core',
      namespace: 'stub',
    }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'export default {};',
      loader: 'js',
    }));
  },
};

// Force all React ecosystem imports to resolve from a single location
const localNodeModules = resolve('node_modules');

export default defineConfig({
  entry: ['src/index.ts', 'src/api.ts', 'src/mcp-server/index.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  splitting: false,
  sourcemap: false,
  dts: {
    compilerOptions: {
      incremental: false,
    },
  },
  minify: true,
  // Don't clean dist/ — it contains dist/web/ built by Vite
  clean: false,
  // Bundle React + ink so there's exactly one instance
  noExternal: ['react', 'ink', 'ink-text-input', 'ink-select-input', 'ink-spinner', 'react-reconciler'],
  // Don't bundle native modules. typescript is external because
  // its compiler source contains top-level `await` mixed with
  // `require()` — when inlined into the single-file ESM bundle
  // via the createRequire banner, Node refuses to load
  // ("Cannot determine intended module format"). Keeping
  // typescript external lets the runtime do a normal
  // require('typescript') via the banner's createRequire, and
  // src/orchestrator/self-bench/schema-handler-audit.ts's
  // `import ts from 'typescript'` still works.
  external: ['better-sqlite3', 'playwright-core', '@jimp/custom', '@jimp/plugin-resize', '@jimp/plugin-scale', '@jimp/plugins', '@nut-tree-fork/nut-js', 'typescript'],
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
  esbuildPlugins: [stubDevtools],
  esbuildOptions(options) {
    options.alias = {
      // Ensure single React instance (ink 6 is compatible with React 19)
      'react': resolve(localNodeModules, 'react'),
      'react/jsx-runtime': resolve(localNodeModules, 'react/jsx-runtime'),
      'react/jsx-dev-runtime': resolve(localNodeModules, 'react/jsx-dev-runtime'),
      // react-reconciler
      'react-reconciler': resolve(localNodeModules, 'react-reconciler'),
      'react-reconciler/constants.js': resolve(localNodeModules, 'react-reconciler/constants.js'),
    };
  },
});
