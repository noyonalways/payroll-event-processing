import path from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  resolve: {
    // `source` outranks `import` so @repo/ui resolves to src, never dist.
    conditions: ['source', 'import', 'module', 'browser', 'default'],
    // Array form: object aliases cannot mix regex `find` entries.
    alias: [
      {
        // Mirror vite.config.ts so tests resolve the same `@/` paths the
        // shadcn/beui components use. `@beui` points at the vendored beUI source
        // inside @repo/ui, matching the Vite alias used for the app build.
        find: /^@\//,
        replacement: `${path.resolve(fileURLToPath(new URL('.', import.meta.url)), 'src')}/`,
      },
      {
        find: '@beui',
        replacement: path.resolve(
          fileURLToPath(new URL('.', import.meta.url)),
          '../../packages/ui/src',
        ),
      },
    ],
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['src/test/setup.ts'],
  },
})