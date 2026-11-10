import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Build to <repo>/dist: the folder Vercel serves (vercel.json outputDirectory and the dashboard default agree).
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/api': `http://localhost:${process.env.API_PORT || 5000}` },
  },
});
