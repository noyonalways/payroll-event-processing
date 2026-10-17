import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Workspace packages resolve to CJS dist files; without include, Vite serves
  // the raw CommonJS as ESM and the browser fails with "does not provide an
  // export named 'EventType'".
  optimizeDeps: {
    include: ['@repo/shared'],
  },
  resolve: {
    alias: {
      // `import.meta.url` form instead of `__dirname`: the config is ESM, so
      // CommonJS globals are unavailable at runtime.
      '@': path.resolve(fileURLToPath(new URL('.', import.meta.url)), 'src'),
    },
  },
});