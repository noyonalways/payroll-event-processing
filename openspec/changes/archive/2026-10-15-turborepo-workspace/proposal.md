# Proposal

## Why

The repository has outgrown a single root package. The backend and the worker share one `package.json`, one `node_modules`, and one test run; the frontend is a *separate* npm project bolted on the side (driven by `npm --prefix frontend`), so it is not a workspace member at all. Nothing enforces which code belongs to which deployable, every command has to be remembered and typed per-target, and there is no task graph: `npm test`, `npm run test:e2e`, and `npm --prefix frontend run test:run` are three unrelated invocations with no dependency ordering, no caching, and no single entry point a CI job or a new contributor can rely on.

This change converts the repository into a Turborepo monorepo with pnpm workspaces: real package boundaries, a dependency-aware task graph, and one command per intent. It is a structural change only — the behaviour of the API, worker, and UI is intended to be identical afterwards, and the existing test suites are the proof.

## What Changes

- **pnpm workspaces replace the ad-hoc layout.** A root `pnpm-workspace.yaml` declares `apps/*` and `packages/*`; `package.json` pins `packageManager: pnpm@12.11.2`; `pnpm-lock.yaml` replaces `package-lock.json`. `frontend/` stops being a side project and becomes a workspace member.
- **Deployables move to `apps/`.** `apps/api` (Nest HTTP entrypoint), `apps/worker` (BullMQ consumer entrypoint), `apps/web` (the React + Vite UI, formerly `frontend/`). Each is thin: its `main.ts` bootstraps a composition root that lives in a shared package.
- **Shared code moves to `packages/`, in five packages with distinct jobs.** `@repo/core` takes the business logic — the whole existing `src/` tree: domain, processing, queue, idempotency, tenancy, auth — and owns both composition roots (`AppModule`, `WorkerModule`). `@repo/database` owns the outbound infrastructure clients: `prisma/schema.prisma`, the migrations, the generated client, `PrismaService`/`PrismaModule`, and the Redis/BullMQ connection module. `@repo/shared` owns the framework-agnostic vocabulary — event types, queue and idempotency constants, the processing result and error shapes — the values both the backend and the UI can agree on without importing a framework. `@repo/eslint-config` and `@repo/typescript-config` hold the shared lint and compiler configuration.
- **The end-to-end suites move with the API, not into a package of their own.** Because the composition roots live in `@repo/core`, `apps/api/test/` can boot both the HTTP and the worker roots without any app depending on another app — so the cross-app suites need no extra package.
- **`turbo.json` defines the task graph.** `build` runs in dependency order (`^build`); `test`, `lint`, and `typecheck` run per package with caching keyed on inputs; `dev` is persistent and uncached; `test:e2e` is uncached because it drives real Postgres and Redis. Environment variables that affect output are declared so the cache cannot serve a stale result.
- **Environment files stay at the repository root** and are resolved explicitly, because Turborepo runs each task with the *package* directory as the working directory — a bare `.env.development` would silently stop resolving once the apps move.
- **Docker builds become workspace-aware.** Each app carries its own Dockerfile built from the repository root as context, installing only what that app needs from the frozen lockfile. The compose topology and the five services are unchanged.
- **CI moves to the workspace entry points.** pnpm setup plus `turbo run` for the cached, dependency-ordered jobs, and a pnpm-filtered e2e job against the service containers.

## Capabilities

### New Capabilities
- `monorepo-workspace`: The workspace contract — how the repository is laid out into deployable apps and shared packages, how a package is consumed by another (declared dependency plus `exports` entrypoint, never a relative path across the boundary), and how the task graph is invoked and cached so one command builds, lints, type-checks, or tests everything in dependency order.

### Modified Capabilities
- `infrastructure-setup`: The three requirements name repository paths that this change moves — the Prisma schema and its initial migration now live in a package, `.env.example` at the root stays but the environment contract around it is explicit, and the compose service build contexts point at the app packages.
- `frontend-app`: The containerization requirement names `docker/Dockerfile.frontend`; the UI now lives in `apps/web` and is built from its own Dockerfile with the repository root as context. The observable behaviour (UI on port 5173, `VITE_API_URL` respected) is unchanged.

## Non-goals

- **No dependency upgrades.** Every existing pin is kept exactly as-is (NestJS 11, Prisma 6, Jest 29, Vite 8, React 19, TypeScript 5.7 in the backend and 6.0 in the UI). Adding `turbo@2.11.8` is the only new tooling. Upgrading a major is a behaviour change and gets its own change, with its own spec deltas and migration notes — bundling six breaking majors into a directory move would make a red suite impossible to attribute.
- **No publication of the internal packages.** They are private workspace members; nothing is published to a registry and no versioning/release pipeline is introduced.
- **No remote caching.** Turborepo's local cache only; wiring a remote cache is a follow-up that needs a storage provider decision.
- **No behavioural changes.** No endpoint, schema, queue, or UI behaviour is intended to change. The lockfile change (npm → pnpm) and the resulting dependency *resolution* is the one place a real-world difference could hide, which is why the existing suites are the acceptance gate.
- **No TypeScript version unification.** The two packages keep their current versions; a shared preset package deduplicates the compiler *options* without changing which compiler each uses.

## Impact

- **Repository layout**: `src/` → `packages/core/src/`, `prisma/` → `packages/database/prisma/`, the framework-agnostic primitives extracted from both into `packages/shared/`, `frontend/` → `apps/web/`, `test/` → `apps/api/test/`, `apps/worker/` → `apps/worker/` (entrypoint kept, module moved out), `docker/Dockerfile.*` → per-app Dockerfiles. Moves use `git mv` so file history is preserved.
- **Tooling**: pnpm replaces npm as the package manager (lockfile regenerated); `turbo.json`, `pnpm-workspace.yaml`, and `.npmrc` are new; root scripts become thin `turbo run` wrappers.
- **Package boundaries**: every existing `../` import that crosses a new boundary is rewritten to a `@repo/*` import; imports *inside* a moved tree (which are relative) keep working unchanged, which keeps the rewrite mechanical and reviewable.
- **Docker**: three Dockerfiles move next to their apps and build from the repository root; `docker/docker-entrypoint.sh` moves with the API and its `prisma migrate deploy` gains an explicit schema path; compose `build.context`/`dockerfile` change. The five services, ports, and health checks are unchanged.
- **CI**: `.github/workflows/ci.yml` gains pnpm setup and switches its three jobs to workspace commands; the e2e job keeps its Postgres/Redis service containers and its `AUTH_JWT_SECRET`.
- **Documentation**: README (installation, every command, project structure) and `docs/architecture.md` (component map, build/deploy sections) are updated to the new layout.
- **Risk to watch**: pnpm's dependency isolation is stricter than npm's — a dependency that was previously resolvable by hoisting may now be correctly reported as undeclared. Any such finding is a latent bug being surfaced, not a regression to paper over with hoisting.
