## 1. Schema & configuration

- [x] 1.1 Add nullable `result Json?` column to `PayrollEvent` in `prisma/schema.prisma` (map `result`), create migration `add_processing_result`, run `prisma generate`, and confirm `Prisma.PayrollEvent` includes `result`
- [x] 1.2 Add `PAYROLL_FAILURE_MODE` to the Joi validation schema in `apps/worker/src/worker.module.ts` (allow `always-success|always-transient|always-permanent`, optional/absent = random) and to `src/app.module.ts` for consistency (allowUnknown already tolerates absent)
- [x] 1.3 Update the `.env.example` / `.env.*` files with documented `PAYROLL_TEMPORARY_FAILURE_RATE`, `PAYROLL_PERMANENT_FAILURE_RATE`, and `PAYROLL_FAILURE_MODE` lines

## 2. Processing module core (`src/processing/`)

- [x] 2.1 Define the result contract: `ProcessingResult` = `{ reference: string; employeeId: string; effectiveDate: string; acknowledged: Record<string, unknown> }` as a TypeScript interface
- [x] 2.2 Define the failure error classes `TransientPayrollFailureError` and `PermanentPayrollFailureError` sharing a base `PayrollProcessingError` with `isTransient` flag (**reliability-critical — temp vs permanent distinction (R1) groundwork**)
- [x] 2.3 Implement `FailureConfig` (reads `PAYROLL_TEMPORARY_FAILURE_RATE` / `PAYROLL_PERMANENT_FAILURE_RATE` / `PAYROLL_FAILURE_MODE` from `ConfigService`) and `SimulatedPayrollProvider` that rolls a transient/permanent/success outcome per call honoring the deterministic override (design D2)
- [x] 2.4 Write unit tests for `SimulatedPayrollProvider` covering all three `PAYROLL_FAILURE_MODE` overrides, zero-failure-rates, and both rate configs (write alongside 2.3)

## 3. Handler strategy registry

- [x] 3.1 Define the handler interface (e.g. `PayrollEventStrategy.handle(input: HandlerInput): Promise<ProcessingResult>`) in `src/processing/`
- [x] 3.2 Implement `HandlerRegistry` with `Record<EventType, PayrollEventStrategy>` and `resolve(eventType)` that throws on an unregistered type, mirroring `PayloadDtoRegistry` (design D1)
- [x] 3.3 Implement the three per-type handlers (`BankAccountChangeHandler`, `AddressChangeHandler`, `SalaryChangeHandler`), each building a `ProcessingResult` acknowledging the type-specific fields (spec: typed simulated result scenarios)
- [x] 3.4 Create `ProcessingModule` exporting `HandlerRegistry` and the provider; implement `3.2`/`3.3` unit tests alongside — registry resolves all three types + fails fast on unknown; each handler returns the acknowledged-field result

## 4. Worker integration (`apps/worker/`)

- [x] 4.1 Import `ProcessingModule` into `WorkerModule` (extends `QueueModule`/`PrismaModule` wiring); ensure constructor injection order still compiles
- [x] 4.2 Update `PayrollEventProcessor.process()` to, after the guarded claim, emit `started`, dispatch via `HandlerRegistry.resolve(eventType).handle(...)`, on success store `result` + transition `processing → success` with `processed_at` (guarded), on failure log + transition `processing → failed` (guarded, no result, no re-enqueue) (`**reliability-critical — exactly-once guarded writes (R5), crash-safe failure path (R4)**`)
- [x] 4.3 Keep the stale/duplicate skip and the `completed`-event FIFO relay **unchanged** and add `succeeded`/`failed` log lines with full event context (`eventId`, `employeeId`, `eventType`, `sequence`, attempt, worker)
- [x] 4.4 Update `apps/worker/src/payroll-event.processor.spec.ts` for the new constructor (third dependency) and add unit tests: success stores result + `succeeded`, handler-throws → `failed` with no result, stale job never invokes a handler (write alongside 4.2)

## 5. End-to-end verification

- [x] 5.1 Extend `test/event-queue.e2e-spec.ts` (or add `test/processing.e2e-spec.ts`) for the full lifecycle with the worker running: submit → row reaches `success` with a non-null `result` and `processed_at` (**reliability-critical — full lifecycle (R4/R5)**)
- [x] 5.2 Add an e2e failure scenario driving `PAYROLL_FAILURE_MODE=always-transient` (or a stubbed provider): submit → row reaches `failed`, `result` NULL, no re-enqueue loop
- [x] 5.3 Run `npm run lint:check`, `npm test`, `npm run test:e2e`, and `npm run build` green; confirm `docker compose up --build` still boots API + worker with the new env vars documented