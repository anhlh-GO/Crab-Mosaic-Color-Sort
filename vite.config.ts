import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// One self-contained dist/index.html: the shell app receives exactly one file
// and must run it offline.
export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
  build: {
    target: 'es2020',
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 20_000,
  },
});
