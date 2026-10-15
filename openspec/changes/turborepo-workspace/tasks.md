# Tasks

## 1. Prerequisite — land the current work first

- [x] 1.1 Commit the multi-tenant work on `main` (94 files) and archive it with `openspec archive multi-tenant-foundation` — verify `openspec/specs/` now contains the `authentication` and `tenancy` capabilities and `openspec list` reports no other active change
- [x] 1.2 Create a dedicated branch for the restructure and verify it is not `main`, so the whole move is reversible by reverting one branch

## 2. Workspace skeleton

- [x] 2.1 Add `pnpm-workspace.yaml` declaring `apps/*` and `packages/*`, and convert the root `package.json` to a private workspace root pinning `packageManager: pnpm@12.11.2` with `turbo@2.11.8` as its only new devDependency — verify `pnpm install` resolves every existing workspace member
- [x] 2.2 Add `.npmrc` allowlisting `pnpm.onlyBuiltDependencies` for the packages that need install scripts (Prisma client and engines, esbuild, the Tailwind oxide binary) — verify `pnpm install` runs those scripts and `pnpm --filter @repo/database exec prisma -v` reports a working CLI
- [x] 2.3 Add `turbo.json` declaring `build` (`dependsOn: ["^build"]`, with outputs), `lint`, `typecheck`, `test` (cached, with declared environment inputs), `test:e2e` and `dev` (`cache: false`, with `dev` persistent), plus `globalEnv` — verify `pnpm turbo run build --dry=json` reports the package/task graph and names the members it would run
- [x] 2.4 Add root scripts as thin `turbo run` wrappers (build, lint, typecheck, test, test:e2e, dev per app) — verify each root script dispatches to the graph rather than to a hard-coded path
- [x] 2.5 Regenerate the lockfile with pnpm and delete `package-lock.json`, keeping every version range unchanged — verify the diff touches only the lockfile and the root manifest and that no dependency range was widened

## 3. `@repo/database` — the outbound clients (do this first: riskiest tooling)

- [x] 3.1 `git mv prisma/ packages/database/prisma/` and confirm the move is recorded as a rename, so the schema and migration history keep their attribution
- [x] 3.2 Add `packages/database/package.json` (name, private, a `build` script compiling to `dist/` with declarations, `exports` pointing at `dist`, plus `generate`/`migrate` scripts, and dependencies on `@prisma/client` and `prisma`) — verify `pnpm --filter @repo/database exec prisma validate` passes against the moved schema
- [x] 3.3 Move `PrismaService` and the global `PrismaModule` into the package and export them — verify a Nest application importing the package can inject `PrismaService` without importing it explicitly, preserving the current global-module behaviour
- [x] 3.4 Move the Redis/BullMQ connection module (`queue.module.ts`, `worker-options.ts`) into the package and export it, leaving the producer and the FIFO/relay semantics in `core` — verify a producer written against the exported queue token still resolves
- [x] 3.5 Regenerate the Prisma client from the new location and run one real query against the scratch database — verify the client resolves and returns rows, proving generation works under pnpm's isolated `node_modules`
- [x] 3.6 Verify `prisma migrate deploy` applies the full history from the package's schema path against a fresh database, and is idempotent on a second run

## 4. Shared configuration packages

- [x] 4.1 Add `packages/typescript-config` with a base preset plus a Nest-flavoured and a React-flavoured preset, each reproducing the compiler options the packages use today — verify a package extending each preset type-checks with the same options as before (no diff in `tsc --showConfig` behaviour)
- [x] 4.2 Add `packages/eslint-config` exporting the backend flat config — verify `api`, `worker`, `core`, `database`, and `shared` all lint through it and report the same results as the pre-move root config
- [x] 4.3 Verify `turbo run typecheck` and `turbo run lint` are now real per-package tasks rather than no-ops

## 5. `@repo/core` — the business logic

- [x] 5.1 `git mv src/ packages/core/src/` — verify the move is recorded as renames and that intra-tree relative imports still resolve (run a package-local typecheck before touching any import)
- [x] 5.2 Add `packages/core/package.json` with its own dependencies (NestJS runtime, `bullmq`, `@nestjs/jwt`, `class-validator`, `joi`, and `@repo/database`) a `build` script compiling to `dist/` with declarations, and an `exports` map pointing at `dist` while exposing both composition roots and the shared surface (see design D6: source-only packages break `nest build`) — verify `pnpm --filter @repo/core exec tsc --noEmit` reports no unresolved module
- [x] 5.3 Rewrite only the imports that cross the new boundary (the composition roots' database/queue imports, and the worker's `../../../src/...` imports) — verify `grep -rn "\.\./\.\./\.\." apps packages` finds no relative import escaping its own package
- [x] 5.4 Run the 187 unit tests from inside the package — verify they pass unmodified apart from import paths, confirming the move changed no behaviour

## 6. `@repo/shared` — the framework-agnostic vocabulary (its own commit)

- [x] 6.1 Extract the primitives that need no framework into `packages/shared`: the supported event types, the queue name and job name, the idempotency constants and header contract, the processing result type, the processing error classes, and the demo-scenario mapping — verify the package declares no framework, database, or queue dependency and that importing it initialises none of them
- [x] 6.2 Point `core` at the extracted modules and delete the originals — verify the unit suite is green, which is the gate for the only non-move step in this change
- [x] 6.3 Add the package's manifest, a `build` script compiling to `dist/` with its `exports` pointing there, and an extended `typescript-config` preset, and declare it as a dependency of `core` and `apps/web` — verify the workspace reports at least two consumers, satisfying the "no single-consumer package" rule
- [x] 6.4 Verify the extraction took only framework-agnostic code: DTOs carrying framework decorators stay in `core` — verify `shared`'s transitive runtime imports contain no NestJS, Prisma, or BullMQ module

## 7. `apps/api` — the HTTP entrypoint and its suites

- [ ] 7.1 Create `apps/api` as an entrypoint (`main.ts` bootstrapping the HTTP composition root from `@repo/core`, plus its manifest declaring only its own dependencies) — verify `pnpm --filter @repo/api build` produces a runnable output and does not build its siblings as a side effect
- [ ] 7.2 Start the API from the workspace root and from inside its own directory — verify both reach `/health` with `200` and both return `401` on a protected route without a token, so the entrypoint is working-directory independent
- [ ] 7.3 `git mv test/ apps/api/test/` and add the test dependencies and jest e2e config to the app — verify the moved suites resolve `@repo/core` and that no app depends on another app
- [ ] 7.4 Rewrite the suites' `../src/...` imports to `@repo/core` and confirm the shared auth helper still resolves
- [ ] 7.5 Run all 10 e2e suites (66 tests) against real Postgres and Redis — verify they pass, which is the primary evidence that the restructure changed no behaviour

## 8. `apps/worker` — the consumer entrypoint

- [ ] 8.1 Create `apps/worker` as an entrypoint around the consumer composition root from `@repo/core`, keeping its own narrower configuration schema — verify the worker boots, registers a heartbeat, and consumes a job
- [ ] 8.2 Submit an event against the running API and verify the worker drains it to a terminal state, exercising the queue path across the new package boundaries

## 9. `apps/web` — the UI

- [ ] 9.1 `git mv frontend/ apps/web/` — verify renames are preserved and the app's name, scripts, and Vite config work from the new location
- [ ] 9.2 Adopt `@repo/shared` for the event-type contract and the error-body shape and delete the local duplicates — verify the UI's existing tests still pass and that `eventTypes` now has a single definition in the workspace
- [ ] 9.3 Verify the UI's 78 Vitest tests and its production build both pass from the new location, and that the production bundle contains no database or queue client pulled in through `shared`
- [ ] 9.4 Verify `VITE_API_URL` handling is unchanged by mounting the UI in the task graph — a build with a non-default value targets that origin

## 10. Configuration resolution

- [ ] 10.1 Add the workspace-root environment resolver to `core` (walk up to the workspace marker, return `<root>/.env.<NODE_ENV>`, fail loudly when absent) and wire both composition roots to it — verify each app loads the root env file when launched from the root and from its own directory
- [ ] 10.2 Verify a deliberately missing environment file produces a startup failure naming the file it looked for, rather than an app that starts with unset configuration
- [ ] 10.3 Verify the container path is unaffected: with configuration injected as environment variables and no env file present, both apps still start

## 11. Docker and compose

- [ ] 11.1 Move `docker/Dockerfile.api` and `docker/Dockerfile.worker` beside their apps and add `apps/web/Dockerfile`, each building with the workspace root as context and installing from the frozen lockfile filtered to that app — verify each image builds and does not contain a sibling app's dependencies
- [ ] 11.2 Move `docker/docker-entrypoint.sh` with the API and point its `prisma migrate deploy` at the schema inside `@repo/database` — verify the container applies pending migrations on start
- [ ] 11.3 Retarget `docker-compose.yml` build contexts and dockerfiles, keeping the five services, ports, and health checks unchanged — verify `docker compose up --build` reaches all five services healthy
- [ ] 11.4 Run the container smoke test (register an organization, submit an event, observe a terminal state, confirm a second organization sees none of it) — verify it passes against the containerised stack

## 12. CI

- [ ] 12.1 Replace the npm setup in all three CI jobs with pnpm setup at the pinned version, restoring the pnpm store cache — verify a run installs from the frozen lockfile
- [ ] 12.2 Switch the backend and frontend jobs to workspace task commands (dependency-ordered, cached) and keep the e2e job's Postgres/Redis service containers, its `AUTH_JWT_SECRET`, and its scope narrowed to `apps/api` — verify all three jobs pass on a pull request
- [ ] 12.3 Verify the boundary requirement holds in CI: an undeclared dependency import fails to resolve rather than passing because a sibling declared it

## 13. Documentation

- [ ] 13.1 Update `README.md` (prerequisites, install, every command, project structure, Docker, tests, the environment-file story, and which package owns what) — verify every documented command runs as written from the root
- [ ] 13.2 Update `docs/architecture.md` (component map, build/deploy sections, the workspace and package-boundary decisions) — verify it names the real paths and no section still references the pre-move layout
- [ ] 13.3 Add the workspace conversion to `openspec_roadmap.md` as the next shipped change

## 14. Verification gate

- [ ] 14.1 Run `pnpm turbo run lint typecheck test build` from the root — verify every task is green and that a second run is served from cache
- [ ] 14.2 Verify cache correctness: change one source file in `core` and confirm the dependent members' tasks re-execute; change a declared environment variable and confirm the affected task re-executes instead of serving a cached result
- [ ] 14.3 Verify the UI suite and build are green through the workspace commands
- [ ] 14.4 Verify a task invoked from inside a member's directory behaves identically to the same task invoked from the root
- [ ] 14.5 Verify the boundary rules by inspection and by attempt: no relative import crosses a package line, and `shared` has at least two consumers and no framework dependency
- [ ] 14.6 Verify the full gate once more after all moves land: unit, e2e against real services, and the containerised stack

## Workflow follow-up

- Archive this change once review is satisfied, and verify the resulting capability specs under `openspec/specs/` reflect these deltas.
