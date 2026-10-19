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
    // `source` outranks `import` so @repo/ui resolves to src, never dist.
    conditions: ['source', 'import', 'module', 'browser', 'default'],
    // Array form: object aliases cannot mix regex `find` entries.
    alias: [
      {
        // `import.meta.url` form instead of `__dirname`: the config is ESM, so
        // CommonJS globals are unavailable at runtime.
        find: /^@\//,
        replacement: `${path.resolve(fileURLToPath(new URL('.', import.meta.url)), 'src')}/`,
      },
      // beUI components are vendored into @repo/ui and keep their upstream
      // `@beui/*` imports. Both the prebuilt dist and the TS source resolve
      // back to the package's src, so the app always compiles one copy.
      {
        find: '@beui',
        replacement: path.resolve(
          fileURLToPath(new URL('.', import.meta.url)),
          '../../packages/ui/src',
        ),
      },
    ],
  },
});