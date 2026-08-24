# Design: Swagger / OpenAPI Documentation

## Context

NestJS 11 + Express 5. `src/main.ts` wires a global `ValidationPipe`, the global `HttpExceptionFilter`, CORS, and listens on `PORT` (default 3000). Routes are flat (no global prefix): `POST /events` and `GET /health`. DTOs are class-validator-driven. `openspec/config.yaml` already promises Swagger at `GET /api-docs` and `GET /api-docs-json`. There is currently no interactive way to exercise the API outside the test suites.

No database schema changes are involved in this change.

## Goals / Non-Goals

**Goals:**
- Always-on Swagger UI + raw OpenAPI JSON with zero environment gating.
- Complete, accurate, and testable documentation of the two existing operations (`POST /events`, `GET /health`).
- A one-call setup so `src/main.ts` stays tidy.
- Runtime behavior unchanged — annotations are metadata only.

**Non-Goals:**
- CI workflow and final README/diagram (change 11 `ci-and-docs`).
- Authentication/API-key documentation (the service has none).
- Documentation of endpoints that do not exist yet (`GET /events`, change 8).
- Hand-authored OpenAPI YAML — the document is generated from code annotations.
- Configuring the `@nestjs/swagger` CLI plugin (deep-import/symbol generation makes documents non-deterministic).

## Decisions

### D1 — Dependency: `@nestjs/swagger@^11` (runtime)
Install as a regular `dependency`, not `devDependency`. The API production image runs `npm prune --omit=dev` in `docker/Dockerfile.api`, so the docs must survive in the runtime image. `^11` resolves to ~11.4.7; peers (`@nestjs/core`/`@nestjs/common` ^11, `class-validator *`, `class-transformer *`, `reflect-metadata` ^0.2) are already satisfied. The CLI plugin is intentionally NOT enabled — every annotation is explicit so the emitted document is deterministic and does not depend on reflecting `!`-declared class properties.

### D2 — Always-on wiring in a dedicated setup file
New `src/common/swagger/setup-swagger.ts` exports `setupSwagger(app: INestApplication, port: number): void`. `src/main.ts` calls it after `enableCors()` and before `await app.listen(port)`. There is no env check and no flag. `swagger-options` include `docExpansion: 'list'`, `filter`, and alphabetical tag/operation sorting.

Reliability mapping: guarantees the API is documented in every `NODE_ENV` (development/test/production) — no configuration drift between environments.

### D3 — Two endpoints via `SwaggerModule.setup`
`SwaggerModule.setup('/api-docs', app, document, { jsonDocumentUrl: '/api-docs-json', customSiteTitle, swaggerOptions })`. Without an explicit `jsonDocumentUrl` the default would already be `/api-docs-json` (path + `-json`); it is set explicitly for readability. No `useGlobalPrefix` handling is required because no global prefix exists.

### D4 — DocumentBuilder configuration
`.setTitle('Payroll Event Processing API')`, `.setVersion('1.0.0')`, `.setDescription(...)`, `.setOpenAPIVersion('3.1.0')` (matches the stack doc in `openspec/config.yaml`), `.addTag('events', ...)`, `.addTag('health', ...)`, `.addServer(http://localhost:${port}, 'Local')`. CORS is already enabled globally, so the browser UI can call the API directly.

### D5 — Annotation strategy
- **Controllers**: `@ApiTags` (class) + `@ApiOperation` + `@ApiResponse` per status code; the `Idempotency-Key` header on `POST /events` is declared with `@ApiHeader({ required: true })`.
- **Request body**: `@ApiBody({ type: CreateEventDto, examples: EVENT_EXAMPLES })` — the media type carries a `$ref` schema plus three named examples; Swagger UI renders an example dropdown and one-click "Try it out".
- **`payload` field**: `@ApiProperty({ oneOf: [$ref …] })` via `getSchemaPath`, plus `@ApiExtraModels(...)` so all three payload DTO schemas land in `components/schemas`. Alternatives considered: `type: Object` + single example was rejected because the per-type payload schemas would never enter `components`; `oneOf` keeps the schema honest while the media examples preserve testability.
- **Responses**: `EventSubmissionResponseDto` (201), `ErrorResponseDto` (matches the global `HttpExceptionFilter` shape: `statusCode`, `message` as `string | string[]`, `error`, `timestamp`, `path`), `HealthResponseDto` (200).
- **Health**: the current `HealthResponse` is an **interface** (erased at runtime — not introspectable); it is replaced by an equivalent `HealthResponseDto` **class** so swagger can infer the schema. Runtime shape is identical.
- **Payload DTOs**: `@ApiProperty` on every field with type/description/example, documenting the IBAN pattern, ISO-8601 date format, ISO 4217 3-letter currency, and positive salary.

## Risks / Trade-offs

- **Annotations are metadata-only** → They cannot change runtime validation, dedup, or the stored-response path. Existing unit and e2e suites stay green without edits.
- **e2e harness does not call `src/main.ts`** → Swagger wiring won't surface in the existing e2e suite; an additive `test/api-docs.e2e-spec.ts` calls `setupSwagger` directly on its `Test.createTestingModule` app.
- **OpenAPI 3.1 rendering quirk in swagger-ui** → Mitigation: removing the single `.setOpenAPIVersion('3.1.0')` line falls back to the module's 3.0 default with no other change.
- **IBAN `pattern` escaping** → The OpenAPI `pattern` is a regex string; in a TypeScript string literal the backslashes must be escaped (`'^[A-Z]{2}\\d{2}[A-Z0-9]{11,30}$'`) so the emitted JSON contains `\d`.

## Migration Plan

No deployment-specific migration: the API container gains a runtime dependency and serves two new GET routes. Rollback is reverting the commit (routes disappear with the code). Dockerfiles require no changes.

## Open Questions

None — scope and behavior are fixed by the proposal and delta spec.