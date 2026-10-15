# Design

## Context

See `proposal.md` — Why. The constraints that shape this design:

- **The backend is one NestJS codebase shared by two processes.** `src/` today holds both the HTTP composition (`AppModule`) and the worker composition (`WorkerModule`), and `apps/worker/` reaches back into it with `../../../src/...`. Any split has to decide where the composition roots live.
- **The end-to-end suites boot the API *and* the worker in one process.** Eight of the ten suites import both modules.
- **Imports inside the existing `src/` tree are relative.** Moving the whole tree keeps them valid; only imports that cross a *new* boundary need rewriting. That is what makes a 90-file move reviewable.
- **`ConfigModule` resolves `.env.<NODE_ENV>` relative to the process working directory,** and Turborepo runs each task with the *package* directory as that directory. The same applies to `prisma migrate deploy` and its schema path.
- **pnpm 10 and later do not run dependency build scripts by default.** Prisma's client generation and Vite's native toolchain depend on them.
- **The UI already maintains a second, hand-written copy of the event-type contract** (`frontend/src/lib/eventTypes.ts`). That duplication is the reason a `shared` package has something real to own.
- **Nothing about the runtime behaviour should change.** The 331 existing tests (187 unit, 66 e2e, 78 frontend) are the acceptance gate.

## Goals / Non-Goals

**Goals:**
- Five packages with distinct, defensible jobs — business logic, infrastructure clients, shared vocabulary, and two configuration packages — and three apps that are deployable units.
- Boundaries enforced by the package manager rather than by convention.
- One command per intent, run from the root, correct across the workspace in dependency order, with caching that never serves a stale result.
- A restructure that is reviewable and reversible: moves are renames, boundaries are explicit, no behaviour in scope.

**Non-Goals:**
- Dependency upgrades of any kind.
- Publication, versioning, or release automation for the internal packages.
- Remote caching.
- Unifying the TypeScript version across packages.
- Changing the Docker topology, ports, or the five-service startup.

## Target layout

```
apps/
  api/        HTTP entrypoint (main.ts) + the end-to-end suites
  worker/     BullMQ consumer entrypoint (main.ts)
  web/        React + Vite UI            (was frontend/)
packages/
  core/               business logic: domain, processing, queue semantics,
                      idempotency, tenancy, auth + BOTH composition roots
  database/           outbound clients: prisma schema, migrations, generated
                      client, PrismaService, Redis/BullMQ connection
  shared/             framework-agnostic vocabulary: event types, queue and
                      idempotency identifiers, result and error shapes
  eslint-config/      shared backend lint configuration
  typescript-config/  shared compiler presets
```

## Decisions

### D1 — Three apps and five packages, split by what each thing is

`apps/` holds what ships as a process: the HTTP API, the worker, and the UI. `packages/` holds everything else, and each package answers a different question — `core` is *what the system does*, `database` is *how it reaches its stores*, `shared` is *what the parts agree on*, and the two config packages are *how the code is checked and compiled*.

The boundary rule that keeps this honest: a package may depend on `shared` and on `database`; it may not reach into another package's files, and `shared` may depend on nothing in the workspace. `core` never depends on an app, and no app depends on another app.

### D2 — `shared` is the framework-agnostic vocabulary, and it must have two consumers

`shared` exists for the values that more than one deployable has to agree on but that neither should own. Concretely, extracted from the current tree: the supported event types, the queue name and job name, the idempotency constants, the processing result type, the processing error classes, and the demo-scenario mapping. None of these needs Nest, Prisma, or Redis.

What makes this a package rather than a folder is that it has **two real consumers**: `core` and `apps/web`. The UI currently keeps its own copy of the event-type contract in `frontend/src/lib/eventTypes.ts`, and the error-body shape it parses is defined again in the backend. Both become imports of `shared`. If a contract has exactly one consumer it does not belong here — it belongs to that consumer — and the spec states that rule so the package cannot drift into a dumping ground.

`shared` therefore declares no framework or client dependency, which is also what makes it usable from a browser bundle. Verified rather than assumed: its dependency list and transitive runtime imports are checked, and its build does not pull a database or queue client into the UI's bundle.

**Alternative:** putting these in `core` and letting the UI import `core`. Rejected — it drags the backend's dependency graph toward a browser build, and it makes "can the UI use this?" a question about the whole backend.

### D3 — `database` owns the outbound clients; the queue's *semantics* stay in `core`

`database` holds the persistence and infrastructure clients: `prisma/schema.prisma`, the migration history, the generated client, `PrismaService`/`PrismaModule`, **and** the Redis/BullMQ connection module (`queue.module.ts`, `worker-options.ts`). Both are outbound clients of the same kind — a store the application talks to and does not own.

What stays in `core` is the part that is not an infrastructure detail: `PayrollEventQueueService` (the producer), the job identity rule, the completion-driven relay, and the transactional claim. The tenant-qualified job id is a correctness rule about FIFO ordering, not a connection setting, and separating it from the connection that carries it would put a business invariant on the other side of a package boundary from the code that enforces it.

**Alternative:** moving the whole queue into `database`. Simpler boundary to explain, but it would put the FIFO/ordering logic in the package that is supposed to hold no business rules.

### D4 — Composition roots live in `core`, so no app depends on another app

`AppModule` and `WorkerModule` move into `@repo/core`, and `apps/api` and `apps/worker` become entrypoints: a `main.ts`, a manifest, a Dockerfile. The consequence is that `apps/api/test/` can boot *both* roots by importing from `core` — the cross-app end-to-end suites need no package of their own and create no dependency between two deployables.

`main.ts` keeps doing exactly what it does today (buffer logs, apply the log level, install the validation pipe and exception filter, register Swagger, listen); it imports its module from a package instead of a sibling directory.

**Alternative:** composition roots in their own apps, with a separate `packages/e2e-tests` that depends on both apps. It works, but it makes two deployables depend on each other's build output in order to test the system, and the e2e package exists only to hold a dependency that shouldn't be needed.

### D5 — pnpm workspaces, not npm workspaces

pnpm was chosen for the property that matters most in a monorepo: **it does not hoist undeclared dependencies into a member's resolution path.** Under npm's flat `node_modules`, a package that imports something it never declared still resolves locally as long as a sibling declared it, then breaks when that sibling is removed or the image is pruned. Under pnpm the import fails at install time.

The cost is paid in this change: a new lockfile, `.npmrc`, CI, and the Dockerfiles. **Alternatives:** npm workspaces (least churn, keeps the committed lockfile, no boundary enforcement); yarn or bun (no advantage here, and bun would change the runtime too).

### D6 — Internal packages are compiled, and their entrypoints point at their build output

`@repo/core`, `@repo/database`, and `@repo/shared` each build to `dist/` with declarations, and their `exports` maps point there. The ordering is what `build`'s `dependsOn: ["^build"]` is for.

The reason is the TypeScript compiler's `rootDir` constraint, and it is a genuine correction to this design as first written. `nest build` compiles an app by following its imports; a `main.ts` that imports a source-only package drags that package's files into a compilation rooted at the app, which either fails the `rootDir` check or emits a `dist/` whose directory structure is computed from the whole graph — and whatever it emits, `require('@repo/core')` at runtime would still resolve to a `.ts` file Node cannot execute. Source-only internal packages are a pattern for *bundled* consumers; Nest's CLI is not one.

**Alternative (superseded):** just-in-time packages exporting TypeScript directly. The documented pattern, and the right one for a Vite or bundler-based consumer — `apps/web` still benefits from that quality of life only because it consumes the built declarations too. If a package is ever published, or consumed by something with its own bundler, the swap is mechanical: point `exports` at `src/`.

The cost is a slower local loop when editing a package: an app's `nest start --watch` does not watch its dependencies, so a package edit needs its build re-run. `turbo watch build` covers exactly that.

### D7 — Environment files stay at the workspace root and are resolved explicitly

Turborepo executes a member's task with that member's directory as the working directory, so `envFilePath: '.env.development'` — which works today only because everything runs from the root — silently stops resolving once an app moves into `apps/`. Silent is the problem: `ConfigModule` does not error on a missing env file, so the app would start with unset configuration.

A small resolver in `core` walks up to the workspace marker (`pnpm-workspace.yaml`) and returns `<root>/.env.<NODE_ENV>`. Every composition root uses it, so any invocation directory resolves to the same file, and the spec requires a loud failure when it is absent.

**Alternatives:** per-app env files (better isolation, but duplicates the shared set across three members, changes the documented workflow, and breaks `env_file:` in compose); relying on the caller's working directory (the trap being fixed).

### D8 — Shared config packages mirror the current options exactly

`@repo/typescript-config` provides a base plus a Nest-flavoured and a React-flavoured preset, each reproducing the options the packages use today, and each package extends the right one. `@repo/eslint-config` exports the backend flat config that `api`, `worker`, `core`, `database`, and `shared` all use. This removes duplication and gives one place to change a rule, **without** changing what any tool does.

Unifying the TypeScript *version* (backend 5.7, UI 6.0) is deliberately out of scope: it is a dependency upgrade, it risks Nest's build, and it would make a red suite ambiguous. Recorded as an open question.

### D9 — Cache the deterministic tasks, declare every input, never cache the ones that touch the world

`build`, `lint`, `typecheck`, and `test` are cached; `dev` and `test:e2e` are not. `dev` is a long-running server, and `test:e2e` drives real Postgres and Redis with time-dependent assertions — caching either means serving a recorded verdict for a live system.

Cache correctness rests on declaring inputs: every environment variable a task's behaviour depends on is listed in `turbo.json`, so a changed `AUTH_JWT_SECRET` or `PAYROLL_FAILURE_MODE` cannot be served a result recorded under a different value. This is the failure mode that makes caching dangerous rather than merely unhelpful.

### D10 — One Dockerfile per app, built from the workspace root

Each app's Dockerfile lives beside it and is built with the repository root as context, because a workspace install needs the root manifest, the workspace declaration, and the lockfile. The install is filtered to the target app (`--filter <app>...`) so an image carries no sibling's dependencies, and it uses the frozen lockfile so an image cannot silently resolve different versions than CI did.

The API's entrypoint moves with the API and keeps `prisma migrate deploy` ahead of the server start, with the schema path now pointing into `@repo/database`. The compose topology, published ports, and health checks are unchanged.

### D11 — Moves are renames; only crossing imports are rewritten

Every relocation uses `git mv`. Imports *inside* a moved tree are relative and therefore still correct afterwards — including the worker's `../../../src/...` imports, which become imports of `core` once that package exists. Only imports that cross a newly-created boundary are edited. Keeping the mechanical part mechanical is what makes a diff of this size reviewable, and it is why the `shared` extraction (which *does* rewrite imports inside `core`) is sequenced as its own step rather than mixed into the move.

### D12 — pnpm must be allowed to run Prisma's and Vite's install scripts

pnpm 10+ blocks dependency build scripts unless the dependency is allowlisted (`pnpm.onlyBuiltDependencies`). Prisma's client generation and Vite's native toolchain both rely on those scripts, so without the allowlist `prisma generate` never runs and the failure looks like a version problem. A known migration trap rather than a design choice, called out because it is the most likely cause of a confusing failure during this change.

### D13 — The multi-tenant work is committed and archived first

A mass file move cannot be reviewed or bisected on top of an uncommitted 94-file diff. The prerequisite is: commit the multi-tenant change, archive it so its deltas land in `openspec/specs/`, *then* start moving files on its own branch. A sequencing decision with a practical basis.

## Risks / Trade-offs

- **pnpm's isolation surfaces a previously-hoisted dependency** → that is the feature working. Fix the manifest by declaring it; never add `shamefully-hoist` to make a latent bug disappear.
- **Prisma under pnpm's isolated linker** (`prisma generate` output, engine binaries) → prove generation and a real query under the new layout *before* moving anything else; `public-hoist-pattern` for Prisma packages is the documented escape hatch if the isolated layout genuinely requires it, applied narrowly and with a comment.
- **NestJS decorators and DI under symlinked `node_modules`** → verify by booting both apps and running the suites; `node-linker` is the fallback knob.
- **The `shared` extraction rewrites imports inside `core`** → it is the one step that is not a pure move, so it lands as its own commit with the unit suite as its gate. Taking the framework-agnostic primitives only (no DTOs, which carry `@nestjs/swagger` decorators) keeps the extraction unambiguous.
- **The UI adopting `shared` changes how Vite resolves a workspace TypeScript package** → verify the UI's Vitest suite and production build, not just the backend; a browser bundle must not inherit a database client.
- **A regenerated lockfile resolves different transitive versions than npm did** → the pin ranges are unchanged, and the full suite plus the containerised stack is the gate. Any behavioural difference that shows up is worth knowing about, which is the argument for not bundling upgrades into the same change.
- **Cache serving a stale result** → declare every environment variable a task depends on; keep the non-deterministic tasks uncached; treat "passed from cache but fails clean" as a `turbo.json` input bug.
- **Images get slower and larger from a workspace install** → filtered installs, separate build and runtime stages, only the app's own output copied forward.
- **A relative path missed during the move fails late** → `typecheck` and `lint` are per-package cached tasks that run on every change, and the import boundary is a spec requirement, so a stray `../` crossing a package line is a reviewable defect rather than a runtime surprise.

## Migration Plan

1. **Prerequisite** — commit the multi-tenant work; archive `multi-tenant-foundation` so its deltas land in `openspec/specs/`.
2. **Branch** — the restructure happens on its own branch, never on `main` mid-flight.
3. **Skeleton** — `pnpm-workspace.yaml`, root `package.json` (private, `packageManager`, `turbo` devDependency), `.npmrc` with the build-script allowlist, `turbo.json`. Verify `pnpm install` resolves the workspace.
4. **`packages/database`** — `git mv prisma/`; add the manifest and exports; move `PrismaService`/`PrismaModule` and the queue connection module in; regenerate; verify a query and `migrate deploy` from the new path. Done first so the riskiest tooling is proven early.
5. **`packages/typescript-config` and `packages/eslint-config`** — extract the shared presets and the flat lint config; verify a package that extends them type-checks and lints identically.
6. **`packages/core`** — `git mv src/`; add the manifest; rewrite only the boundary imports; run the 187 unit tests from inside the package.
7. **`packages/shared`** — extract the framework-agnostic primitives out of `core`; point `core` at them; run the unit suite. This is the one non-move step, so it is its own commit.
8. **`apps/api` and `apps/worker`** — entrypoints around the composition roots in `core`; verify each boots and that the worker drains an event the API accepted.
9. **`apps/web`** — `git mv frontend/`; adopt `shared` for the event-type contract and the error shape, deleting the local duplicates; verify tests and build.
10. **E2E** — `git mv test/ apps/api/test/`; verify all 10 suites.
11. **Configuration** — the workspace-root env resolver; verify from both invocation directories and the loud-failure path.
12. **Docker** — per-app Dockerfiles, retargeted compose contexts, entrypoint schema path; verify the full stack and the container smoke test.
13. **CI** — pnpm setup, workspace commands, cached jobs, e2e filtered to `apps/api`.
14. **Docs** — README and `docs/architecture.md`.
15. **Verification gate** — the full gate below.

**Rollback:** no schema change and no runtime behaviour in scope, so rollback is reverting the branch. `assessment-submission` remains the frozen pre-multi-tenant reference; the pre-move commit is the reference for this change.

**Verification gate for this change:** `pnpm turbo run lint typecheck test build` green from the root, and green again from a cache-free run; the UI suite and build green; `pnpm turbo run test:e2e` green against real Postgres and Redis; `docker compose up --build` reaching five healthy services with a working end-to-end submission; a task invoked from inside a member's directory behaving identically to the same task from the root; and `shared` verified to pull no framework or database client into the UI bundle.

## Open Questions

- **TypeScript version unification.** Backend on 5.7, UI on 6.0. Unifying is a dependency upgrade with real risk to Nest's build; it belongs in its own change once the workspace is stable.
- **Remote caching.** Worth adding for CI once a storage provider is chosen; the local cache suffices for one machine and the existing pipeline.
- **Whether `apps/web` should adopt `@repo/eslint-config`.** The UI lints with oxlint, the backend with ESLint; converging is a tooling preference the workspace does not depend on.
- **Whether `apps/worker` should keep its separate config schema.** It validates its own environment subset and does not need the API's signing key; that asymmetry is intentional and worth revisiting only if a third deployable appears.
