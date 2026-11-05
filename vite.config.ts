import { defineConfig } from 'vite';

// VITE_BASE is set by the GitHub Pages workflow to /<repo-name>/.
export default defineConfig({
  base: process.env.VITE_BASE || '/',
  worker: { format: 'es' },
});
