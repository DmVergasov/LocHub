import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { webDepsPlugin } from './scripts/webDeps.mjs';

export default defineConfig({
  plugins: [react(), webDepsPlugin()],
  // Relative asset URLs: the service serves the app at its root for the editor tab and for an external browser alike.
  base: './',
  build: {
    // The shipped layout (spec §3): fixed names, no hashes, no maps, readable code; the vendor chunk moves to
    // Source/ThirdParty/LocHubWebDeps after the build (scripts/webDeps.mjs).
    outDir: '../Resources/LocHubWeb',
    emptyOutDir: true,
    sourcemap: false,
    minify: false,
    cssCodeSplit: false,
    // The editor's embedded browser (and every current desktop/mobile browser) supports <link rel="modulepreload">
    // natively (node_modules/vite/dist/node/index.d.ts: ModulePreloadOptions.polyfill, "@default true"), so Vite's
    // own polyfill (MIT, vendored by inlining it into our entry chunk) has nothing to do here; leaving the default
    // on would ship third-party code outside Source/ThirdParty (Fab 4.3.7.3.d).
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        entryFileNames: 'lochub_web.js',
        chunkFileNames: '[name].js',
        assetFileNames: 'lochub_web[extname]',
        manualChunks: (id) => (id.includes('node_modules') ? 'lochub_web_deps' : undefined),
        // Rollup's own `output.banner` addon computes the right text here (verified: node_modules/rollup/dist/
        // shared/rollup.js, createAddons() inside Chunk.render()) but this project's Vite build (plugin-react +
        // cssCodeSplit: false) does not carry it through to the bytes actually written for either chunk — traced
        // as far as confirming Rollup's own renderChunk/generateBundle hooks still see the right banner right up
        // to the write, yet the file on disk lacks it. scripts/webDeps.mjs prepends the same publisher line
        // (release_checks.mjs's COPYRIGHT_LINE) to every .js file at writeBundle time instead: same requirement
        // (spec §3 / Fab 4.3.6.1.b), a mechanism that is actually provable by reading the file back.
      },
    },
  },
  // `npm run dev` talks to a running `lochub serve` on the default port. changeOrigin rewrites Host to 127.0.0.1:47810:
  // the service answers 403 to any other Host (CONTRACT.md, "Request hygiene"), including the dev server's localhost:5173.
  server: { proxy: { '/api': { target: 'http://127.0.0.1:47810', changeOrigin: true } } },
  test: { environment: 'jsdom', setupFiles: ['./test/setup.ts'], include: ['test/**/*.test.{ts,tsx}'] },
});
