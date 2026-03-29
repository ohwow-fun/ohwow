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
  // Don't bundle native modules
  external: ['better-sqlite3', 'playwright-core'],
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
