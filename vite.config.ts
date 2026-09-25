import { defineConfig } from 'vite';

// Static site for GitHub Pages: relative base so it works under /sql2m/.
export default defineConfig({
  root: 'web',
  base: './',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'es2022',
  },
  worker: { format: 'es' },
});
