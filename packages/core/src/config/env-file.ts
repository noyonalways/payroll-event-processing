import { existsSync } from 'node:fs';
import * as path from 'node:path';

/**
 * Stage environment files (`.env.<NODE_ENV>`) live with the API app, not at the
 * workspace root (design D7, amended). `apps/api` is the app a developer runs on
 * the host, so its stage files are the single host-local copy the backend apps
 * share; containers never carry them — compose injects the same values as
 * environment variables instead.
 */
const ENV_FILE_APP_DIR = path.join('apps', 'api');

/** Marker that identifies the workspace root while walking up. */
const WORKSPACE_MARKER = 'pnpm-workspace.yaml';

function findWorkspaceRoot(from: string): string | null {
  let dir = path.resolve(from);
  for (;;) {
    if (existsSync(path.join(dir, WORKSPACE_MARKER))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolves the stage env file for the active `NODE_ENV` to an ABSOLUTE path, so
 * the Nest `ConfigModule` lookup stops depending on the process working
 * directory: an app launched from the workspace root, from its own directory,
 * or through turbo always resolves the same file.
 *
 * Fails loudly, naming the file it looked for, when no stage file exists for
 * the environment and the required variables were not injected another way.
 * The relative lookup this replaces (`envFilePath: '.env.<NODE_ENV>'`) would
 * have started the app *silently unset* instead.
 *
 * A run whose configuration arrives as environment variables — the container
 * path (see `docker-compose.yml`) — needs no file and proceeds.
 *
 * @param requiredWhenNoFile variables that, when all present in `process.env`,
 *   prove the configuration was injected and the absent file can be skipped;
 *   the first missing one is named in the failure.
 * @param nodeEnv active environment selecting `.env.<NODE_ENV>`.
 */
export function resolveStageEnvFile(
  requiredWhenNoFile: string[],
  nodeEnv: string = process.env.NODE_ENV ?? 'development',
): string {
  const root = findWorkspaceRoot(process.cwd()) ?? process.cwd();
  const envFile = path.join(root, ENV_FILE_APP_DIR, `.env.${nodeEnv}`);

  if (existsSync(envFile)) return envFile;

  const missing = requiredWhenNoFile.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(
      `Environment file not found: ${envFile} — refusing to start with unset ` +
        `configuration. Copy .env.example to apps/api/.env.${nodeEnv} on the ` +
        `host, or inject the missing variables (${missing.join(', ')}) through ` +
        `the environment, as docker compose does.`,
    );
  }

  // Absent, but the environment carries the configuration (container path).
  return envFile;
}
