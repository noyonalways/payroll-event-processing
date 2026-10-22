/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Base origin of the payroll API (e.g. `http://localhost:4000`).
   * Injected at build time by Vite; documented in `frontend/.env.example`.
   */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}