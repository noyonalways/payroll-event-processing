# Tasks: Swagger / OpenAPI Documentation

## 1. Dependencies

- [x] 1.1 Install `@nestjs/swagger@^11` (`npm install @nestjs/swagger@^11`); confirm it is saved under `dependencies` in package.json and resolves to 11.4.x

## 2. Swagger setup module

- [x] 2.1 Create `src/common/swagger/setup-swagger.ts` — `export function setupSwagger(app: INestApplication, port: number): void` building the OpenAPI document (DocumentBuilder: title "Payroll Event Processing API", description, version 1.0.0, OpenAPI 3.1.0, tags `events` + `health`, server http://localhost:PORT) and calling `SwaggerModule.setup('/api-docs', app, document, { jsonDocumentUrl: '/api-docs-json', customSiteTitle, swaggerOptions })`
- [x] 2.2 Modify `src/main.ts` — import `setupSwagger`, call it after `app.enableCors()` and before `await app.listen(port)`, passing the ConfigService port

## 3. Request / response / payload schemas

- [x] 3.1 Create `src/common/dto/error-response.dto.ts` — `ErrorResponseDto { statusCode, message (string | string[]), error, timestamp, path }` annotated to match the global `HttpExceptionFilter` shape (message as oneOf string | string-array)
- [x] 3.2 Create `src/events/dto/event-submission-response.dto.ts` — `EventSubmissionResponseDto { id: string (uuid), status: 'received' }`
- [x] 3.3 Create `src/events/dto/event-examples.ts` — `EVENT_EXAMPLES` with three named, valid request bodies (BANK_ACCOUNT_CHANGE, ADDRESS_CHANGE, SALARY_CHANGE) for one-click "Try it out"
- [x] 3.4 Modify `src/events/dto/create-event.dto.ts` — add `@ApiExtraModels` (three payload DTOs), `@ApiProperty` on `eventType` (enum + enumName + example) and on `payload` (oneOf refs via `getSchemaPath` to the three payload DTOs); class-validator decorators untouched
- [x] 3.5 Modify `src/events/dto/payloads/bank-account-change.dto.ts` — `@ApiProperty` on `employeeId`, `effectiveDate` (format: date, ISO example), `iban` (pattern `^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$`, example DE89370400440532013000)
- [x] 3.6 Modify `src/events/dto/payloads/address-change.dto.ts` — `@ApiProperty` on all six fields (description + example each: employeeId, effectiveDate, street, city, postalCode, country)
- [x] 3.7 Modify `src/events/dto/payloads/salary-change.dto.ts` — `@ApiProperty` on `employeeId`, `effectiveDate`, `newSalary` (Number, positive, example 75000), `currency` (3-letter ISO 4217, example EUR)

## 4. Controller annotations

- [x] 4.1 Modify `src/events/events.controller.ts` — add `@ApiTags('events')`; on `create()`: `@ApiOperation`, `@ApiHeader({ name: 'Idempotency-Key', required: true, ... })` (missing header → 400), `@ApiBody({ type: CreateEventDto, examples: EVENT_EXAMPLES })`, `@ApiResponse({ status: 201, type: EventSubmissionResponseDto })`, `@ApiResponse({ status: 400, type: ErrorResponseDto })` — runtime logic byte-identical
- [x] 4.2 Create `src/common/health/health-response.dto.ts` — `HealthResponseDto` class with `@ApiProperty` on `status` ('ok'|'degraded'), `db`/`redis` ('ok'|'error'), `uptime`, `timestamp`
- [x] 4.3 Modify `src/common/health/health.controller.ts` — replace the erased `HealthResponse` interface with the `HealthResponseDto` class (interfaces are not introspectable), add `@ApiTags('health')`, `@ApiOperation`, `@ApiResponse({ status: 200, type: HealthResponseDto })`

## 5. Docs / roadmap

- [x] 5.1 Update `openspec_roadmap.md` — annotate row #11 `ci-and-docs`: note the Swagger/OpenAPI portion is delivered early by change `swagger-openapi` (UI /api-docs, JSON /api-docs-json); remaining scope is CI + final docs
- [x] 5.2 Update `README.md` Getting started — add "API documentation (Swagger/OpenAPI)" block with the two URLs
- [x] 5.3 Update `docs/architecture.md` — mark Swagger as delivered early in the change-11 mapping (CI + final diagram remain)

## 6. Build, lint, tests

- [x] 6.1 `npm run build` green (api) and `nest build worker` still compiles (swagger code type-checked as part of the project but not imported by the worker entrypoint)
- [x] 6.2 `npm run lint:check` green
- [x] 6.3 `npm run test` (unit) green — annotations are metadata-only; no existing spec files change
- [x] 6.4 Create `test/api-docs.e2e-spec.ts` (additive, mirrors event-submission e2e harness) — Test.createTestingModule + HttpExceptionFilter + `setupSwagger(app, 3000)`; assert GET /api-docs → 200 HTML and GET /api-docs-json → 200 JSON with `paths` `/events` + `/health` and the 8 component schemas; run `npm run test:e2e` with Docker Postgres up

## 7. Manual verification

- [x] 7.1 Boot the stack (`docker compose up --build` for api + postgres + redis) or `npm run dev` with local Postgres/Redis
- [x] 7.2 `curl http://localhost:3000/api-docs` → 200 HTML; `curl http://localhost:3000/api-docs-json` → 200 JSON containing `paths./events`, `paths./health`, and the component schemas
- [x] 7.3 Swagger UI "Try it out" on POST /events with the BANK_ACCOUNT_CHANGE example + an Idempotency-Key → 201 `{ id, status: 'received' }`
- [x] 7.4 Repeat the exact same request (same key) → identical 201 body, no second row persisted