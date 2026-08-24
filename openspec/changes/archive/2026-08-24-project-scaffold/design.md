## Context

The repository skeleton exists but has no runnable code. Before any feature work (event API, BullMQ integration, etc.) we need a solid, working baseline: a NestJS application that boots, connects to Postgres and Redis, passes a health check, and can be started locally with `docker compose up --build`. Every later change will layer on top of this scaffold.

## Goals / Non-Goals

**Goals:**
- Bootstrap a NestJS 11 (latest stable, v11.2.x) + TypeScript (strict) application in `src/`
- `GET /health` endpoint — returns `{ status: "ok" }` plus DB/Redis liveness
- Docker Compose with five services: `postgres`, `redis`, `api`, `worker`, `frontend`
- Separate Dockerfiles for `api` and `worker` (multi-stage; dev + prod targets)
- Prisma schema with datasource pointing to `DATABASE_URL`; initial empty migration committed
- ESLint (NestJS-recommended) + Prettier config
- `.env.example` documenting all required environment variables
- npm workspaces root `package.json` referencing `src` (api) and `apps/worker`
- Global `ValidationPipe` (whitelist + forbidNonWhitelisted) registered in `main.ts`
- Global `HttpExceptionFilter` for structured JSON error responses
- NestJS 11 **built-in JSON logger** (`logger: 'json'` in bootstrap options) — no `nestjs-pino` needed

**Non-Goals:**
- No business logic (events, queue, processing) in this change
- No production-grade TLS, secrets management, or Kubernetes configs
- No frontend implementation beyond a placeholder "coming soon" container

## Decisions

### Decision 1 — Monorepo layout: npm workspaces (not Nx/Turborepo)
**Chosen:** minimal npm workspaces with two packages — `src` (api) and `apps/worker`.  
**Why:** Nx/Turborepo adds config overhead not justified for a two-package project. npm workspaces let us share TypeScript source without a build step during development.  
**Reliability link:** n/a (infrastructure).

### Decision 2 — Logging: NestJS 11 built-in JSON logger
**Chosen:** NestJS 11's native `bufferLogs + logger: 'json'` bootstrap option.  
**Why:** NestJS 11 ships with built-in structured JSON logging — there is no longer a need for the `nestjs-pino` third-party package. This reduces dependencies, simplifies setup, and the output is machine-parseable, satisfying the audit/logging requirements out of the box.  
**Files:** `src/main.ts`

### Decision 3 — Health check depth
**Chosen:** `GET /health` performs a `SELECT 1` against Postgres and a Redis `PING`, returns `{ status, db, redis, uptime }`.  
**Why:** A shallow HTTP 200 is not enough to know the service is actually operational. Checking real dependencies gives ops teams actionable signal.  
**Reliability link:** Supports worker crash recovery observability (requirement 4).  
**Files:** `src/common/health/health.controller.ts`

### Decision 4 — Prisma over TypeORM / Drizzle
**Chosen:** Prisma ORM.  
**Why:** Type-safe query client generated from schema; migration tooling is first-class; `prisma.$transaction` API is clean for the exactly-once write patterns needed later (requirement 5).  
**Files:** `prisma/schema.prisma`, `prisma/migrations/`, `src/prisma/prisma.service.ts`

### Decision 5 — Docker Compose service topology
```
postgres ──┐
redis    ──┤─→ api (port 3000)
           └─→ worker (no exposed port)
                      frontend (port 5173, placeholder nginx)
```
`api` and `worker` share the same Docker image but different `command` overrides. Volume mounts enable hot-reload in dev mode.

### Decision 6 — Environment variable strategy
All config loaded via `@nestjs/config` with a validation schema (`Joi` or `zod`). Required vars: `DATABASE_URL`, `REDIS_URL`, `PORT`, `LOG_LEVEL`, `NODE_ENV`. `.env.example` documents all vars with safe defaults.  
**Files:** `src/app.module.ts` (ConfigModule), `.env.example`

## Files Created

```
src/
  main.ts                              ← bootstrap, global pipe/filter, NestJS 11 JSON logger
  app.module.ts                        ← ConfigModule, PrismaModule, EventsModule (stub), HealthModule
  prisma/
    prisma.module.ts
    prisma.service.ts
  events/
    events.module.ts                   ← stub
  common/
    health/
      health.module.ts
      health.controller.ts             ← GET /health
    filters/
      http-exception.filter.ts         ← global exception filter
    logger/
      logger.module.ts                 ← nestjs-pino setup
apps/
  worker/
    src/
      worker.module.ts
      main.ts                          ← standalone worker bootstrap (stub)
prisma/
  schema.prisma                        ← datasource + generator; no models yet
  migrations/
    0000_initial/migration.sql         ← empty initial migration
frontend/
  (placeholder; empty index.html or nginx container)
docker/
  Dockerfile.api                       ← multi-stage; dev + prod targets
  Dockerfile.worker
  .dockerignore
docker-compose.yml
docker-compose.override.yml            ← dev volume mounts, hot reload
.env.example
.eslintrc.js
.prettierrc
tsconfig.json
tsconfig.build.json
package.json                           ← workspaces root
nest-cli.json
```

## Risks / Trade-offs

- **Health check adds a DB round-trip on every ping** → Mitigation: cache the result for 5 s, or add a `?deep=false` query param to skip dependency checks.
- **npm workspaces + NestJS monorepo path aliases** can cause `tsconfig` confusion → Mitigation: explicit `paths` entries and `nest-cli.json` projects config, verified by the build step in CI.
- **Placeholder frontend image** means `docker compose up` works end-to-end from day one but the frontend container is not yet useful → Accepted trade-off; addressed in change 9 (`minimal-frontend`).
