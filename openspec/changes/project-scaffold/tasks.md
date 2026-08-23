## 1. Package & Workspace Setup

- [ ] 1.1 Create root `package.json` with npm workspaces pointing to `src` (api) and `apps/worker`; add scripts: `dev`, `build`, `lint`, `test`
- [ ] 1.2 Create `tsconfig.json` (base strict config) and `tsconfig.build.json` (excludes test files)
- [ ] 1.3 Add `.eslintrc.js` (NestJS-recommended rules) and `.prettierrc`
- [ ] 1.4 Create `nest-cli.json` defining the `api` and `worker` projects

## 2. NestJS Application Bootstrap

- [ ] 2.1 Create `src/main.ts` — NestJS 11 bootstrap with built-in JSON logger (`bufferLogs: true`, `logger: 'json'` in `NestFactory.create` options), global `ValidationPipe` (whitelist + forbidNonWhitelisted), global `HttpExceptionFilter`, and port binding from `ConfigService`
- [ ] 2.2 Create `src/app.module.ts` — import `ConfigModule` (validating required env vars with Joi), `PrismaModule`, `HealthModule`, and stub `EventsModule`
- [ ] 2.3 Create `src/prisma/prisma.service.ts` and `src/prisma/prisma.module.ts` — `PrismaClient` wrapper with `onModuleInit` connect and `onModuleDestroy` disconnect
- [ ] 2.4 Create `src/common/filters/http-exception.filter.ts` — serialise all `HttpException` instances to `{ statusCode, message, error, timestamp, path }`
- [ ] 2.5 Create stub `src/events/events.module.ts` (empty module, no controller yet)

## 3. Health Check Endpoint

- [ ] 3.1 Create `src/common/health/health.module.ts` and `health.controller.ts` implementing `GET /health`
- [ ] 3.2 Implement DB liveness check (`prisma.$queryRaw\`SELECT 1\``) and Redis liveness check (`redis.ping()`) with try/catch returning `"ok"` or `"error"` per dependency
- [ ] 3.3 Return `{ status: "ok" | "degraded", db, redis, uptime }` with HTTP 200 always (never 503 — callers use the body to determine health)
- [ ] 3.4 Write unit test for `HealthController` mocking `PrismaService` and `RedisService` (covers all three scenarios from spec)

## 4. Prisma Schema & Initial Migration

- [ ] 4.1 Create `prisma/schema.prisma` with PostgreSQL datasource (`DATABASE_URL`) and Prisma Client generator; no models yet
- [ ] 4.2 Run `npx prisma migrate dev --name initial --create-only` to generate the empty migration SQL file
- [ ] 4.3 Commit `prisma/migrations/` so `prisma migrate deploy` can be run idempotently in CI and Docker

## 5. Worker Entrypoint (Stub)

- [ ] 5.1 Create `apps/worker/src/worker.module.ts` importing `ConfigModule` and `PrismaModule`
- [ ] 5.2 Create `apps/worker/src/main.ts` — standalone NestJS application factory with Pino logger; no queue consumers yet (wired in change 3)

## 6. Docker & Docker Compose

- [ ] 6.1 Create `docker/Dockerfile.api` — multi-stage: `base` (node:20-alpine + deps), `dev` (hot-reload with ts-node), `build` (compile), `prod` (minimal runtime image)
- [ ] 6.2 Create `docker/Dockerfile.worker` — same multi-stage pattern, different CMD pointing to worker entrypoint
- [ ] 6.3 Create `docker/.dockerignore`
- [ ] 6.4 Create `docker-compose.yml` with services: `postgres` (postgres:16-alpine), `redis` (redis:7-alpine), `api` (port 3000, depends_on postgres + redis, runs migrations on start), `worker` (depends_on api, same image different command), `frontend` (placeholder nginx:alpine serving a static "coming soon" page)
- [ ] 6.5 Create `docker-compose.override.yml` for development: volume mounts for live-reload, `NODE_ENV=development`
- [ ] 6.6 Add a `docker-entrypoint.sh` for the API that runs `prisma migrate deploy` then starts the app

## 7. Environment Configuration

- [ ] 7.1 Create `.env.example` documenting: `DATABASE_URL`, `REDIS_URL`, `PORT` (default 3000), `LOG_LEVEL` (default `info`), `NODE_ENV`
- [ ] 7.2 Add Joi validation schema in `app.module.ts` `ConfigModule` that fails fast if required vars are missing
- [ ] 7.3 Verify `.env` is in `.gitignore` (already present — confirm)

## 8. Smoke Test

- [ ] 8.1 Run `docker compose up --build` locally; verify all five containers start without errors
- [ ] 8.2 Verify `GET http://localhost:3000/health` returns `{ "status": "ok", "db": "ok", "redis": "ok" }`
- [ ] 8.3 Verify `prisma migrate deploy` runs cleanly against the Docker Postgres instance
