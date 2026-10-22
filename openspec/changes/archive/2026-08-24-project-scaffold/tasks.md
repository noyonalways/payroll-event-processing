## 1. Package & Workspace Setup

- [x] 1.1 Create root `package.json` with npm workspaces pointing to `src` (api) and `apps/worker`; add scripts: `dev`, `build`, `lint`, `test`
- [x] 1.2 Create `tsconfig.json` (base strict config) and `tsconfig.build.json` (excludes test files)
- [x] 1.3 Add `.eslintrc.js` (NestJS-recommended rules) and `.prettierrc`
- [x] 1.4 Create `nest-cli.json` defining the `api` and `worker` projects

## 2. NestJS Application Bootstrap

- [x] 2.1 Create `src/main.ts` — NestJS 11 bootstrap with built-in JSON logger (`bufferLogs: true`, `logger: 'json'` in `NestFactory.create` options), global `ValidationPipe` (whitelist + forbidNonWhitelisted), global `HttpExceptionFilter`, and port binding from `ConfigService`
- [x] 2.2 Create `src/app.module.ts` — import `ConfigModule` (validating required env vars with Joi), `PrismaModule`, `HealthModule`, and stub `EventsModule`
- [x] 2.3 Create `src/prisma/prisma.service.ts` and `src/prisma/prisma.module.ts` — `PrismaClient` wrapper with `onModuleInit` connect and `onModuleDestroy` disconnect
- [x] 2.4 Create `src/common/filters/http-exception.filter.ts` — serialise all `HttpException` instances to `{ statusCode, message, error, timestamp, path }`
- [x] 2.5 Create stub `src/events/events.module.ts` (empty module, no controller yet)

## 3. Health Check Endpoint

- [x] 3.1 Create `src/common/health/health.module.ts` and `health.controller.ts` implementing `GET /health`
- [x] 3.2 Implement DB liveness check (`prisma.$queryRaw\`SELECT 1\``) and Redis liveness check (`redis.ping()`) with try/catch returning `"ok"` or `"error"` per dependency
- [x] 3.3 Return `{ status: "ok" | "degraded", db, redis, uptime }` with HTTP 200 always (never 503 — callers use the body to determine health)
- [x] 3.4 Write unit test for `HealthController` mocking `PrismaService` and `RedisService` (covers all three scenarios from spec)

## 4. Prisma Schema & Initial Migration

- [x] 4.1 Create `prisma/schema.prisma` with PostgreSQL datasource (`DATABASE_URL`) and Prisma Client generator; no models yet
- [x] 4.2 Run `npx prisma migrate dev --name initial --create-only` to generate the empty migration SQL file
- [x] 4.3 Commit `prisma/migrations/` so `prisma migrate deploy` can be run idempotently in CI and Docker

## 5. Worker Entrypoint (Stub)

- [x] 5.1 Create `apps/worker/src/worker.module.ts` importing `ConfigModule` and `PrismaModule`
- [x] 5.2 Create `apps/worker/src/main.ts` — standalone NestJS application factory with NestJS 11 logger; no queue consumers yet (wired in change 3)

## 6. Docker & Docker Compose

- [x] 6.1 Create `docker/Dockerfile.api` — multi-stage: `base` (node:20-alpine + deps), `dev` (hot-reload with ts-node), `build` (compile), `prod` (minimal runtime image)
- [x] 6.2 Create `docker/Dockerfile.worker` — same multi-stage pattern, different CMD pointing to worker entrypoint
- [x] 6.3 Create `docker/.dockerignore`
- [x] 6.4 Create `docker-compose.yml` with services: `postgres` (postgres:16-alpine), `redis` (redis:7-alpine), `api` (port 3000, depends_on postgres + redis, runs migrations on start), `worker` (depends_on api, same image different command), `frontend` (placeholder nginx:alpine serving a static "coming soon" page)
- [x] 6.5 Create `docker-compose.override.yml` for development: volume mounts for live-reload, `NODE_ENV=development`
- [x] 6.6 Add a `docker-entrypoint.sh` for the API that runs `prisma migrate deploy` then starts the app

## 7. Environment Configuration

- [x] 7.1 Create `.env.example` documenting: `DATABASE_URL`, `REDIS_URL`, `PORT` (default 3000), `LOG_LEVEL` (default `info`), `NODE_ENV`
- [x] 7.2 Add Joi validation schema in `app.module.ts` `ConfigModule` that fails fast if required vars are missing
- [x] 7.3 Verify `.env` is in `.gitignore` (already present — confirmed ✓)

## 8. Smoke Test

- [x] 8.1 Run `docker compose up --build` locally; verify all five containers start without errors
- [x] 8.2 Verify `GET http://localhost:4000/health` returns `{ "status": "ok", "db": "ok", "redis": "ok" }`
- [x] 8.3 Verify `prisma migrate deploy` runs cleanly against the Docker Postgres instance
