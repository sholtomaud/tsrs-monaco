import { defineConfig } from 'vite';

export default defineConfig({
  worker: {
    // The compiler and runner workers are ES modules with imports.
    format: 'es',
  },
  build: {
    // Monaco's editor core is a single ~2.7 MB chunk; tsrs.wasm is a separate asset.
    chunkSizeWarningLimit: 3000,
    rollupOptions: {
      // The playground, and the page the CI action drives (ci/action.yml).
      input: { main: 'index.html', ci: 'ci.html' },
    },
  },
  optimizeDeps: {
    // @tsrs/wasm locates tsrs.wasm relative to its own module URL.
    exclude: ['@tsrs/wasm'],
  },
});
