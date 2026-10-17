# Tasks

## 1. Provider seam

- [x] 1.1 Introduce `packages/core/src/processing/external-payroll-provider.ts` (interface: `apply(input, tx) → { reference }`) and re-point `SimulatedPayrollProvider` at it; add the `EXTERNAL_PAYROLL_PROVIDER` binding + `provider-resolver.service.ts` (org lookup → simulated default per design D1/D2) — update handler unit specs to the new injection symbol and verify all four handlers pass constructor rewiring with behaviour-identical simulated tests.
- [x] 1.2 Add the `provider_configs` model + mode enum to the Prisma schema (unique org FK per design D2), generate client and migration — verify migration applies and resolver unit mocks compile.
- [x] 1.3 Extend the processing lifecycle log lines with `provider` identity (design D5) — update `payroll-event.processor.spec.ts` assertions; verify `succeeded` lines carry `provider: 'simulated'` today.

## 2. HTTP adapter

- [x] 2.1 Implement `http-payroll-provider.ts` (POST contract + authorization header + `PROVIDER_HTTP_TIMEOUT_MS`, per design D4) with a thin injectable fetch client — unit-test the full classification matrix: 2xx+reference success, 2xx-without-reference transient, timeout/network/5xx transient, 4xx permanent with sanitized reason, malformed 2xx body transient, credential never present in error contents.
- [x] 2.2 Wire the resolver to return the HTTP adapter for `HTTP`-mode configs inside processing (`processing.module.ts` factory) — unit-test resolution precedence (no row → simulated; SIMULATED row → simulated; HTTP row → adapter) and that resolution re-reads config per invocation (no caching) for the no-restart scenario.

## 3. Configuration API

- [x] 3.1 Add the OWNER-gated endpoints `PUT/GET/DELETE /provider-config` (`@Roles(OWNER)`, credential return-once + read-redaction per design D3) with Swagger annotations — e2e (`test/provider-config.e2e-spec.ts`): admin/member `403`, credential not in `GET`/logs, token-scoping, owner create/replace/delete.
- [x] 3.2 Integration proof against a stub HTTP provider in `test/provider-http-processing.e2e-spec.ts` (pattern from the webhook receiver stub): org configures endpoint → event processed → stub received the documented contract (body + authorization header) → event commits `success` with the stub reference; flip stub to 503 then to 422 — verify transient-retry-then-success, and permanent `failed` with FAILED attempt row carrying the rejection detail; assert employee domain state rollback on provider failure. **Reliability-critical: exactly-once + transient/permanent contracts across the seam.**

## 4. Docs and CI

- [x] 4.1 Publish the provider request/response contract in Swagger (`PUT /provider-config` description + a dedicated schema), README integration section — verify `/api-docs` renders the contract.
- [x] 4.2 CI parity run: `pnpm lint`, backend unit + e2e suites, frontend untouched — verify green and that demo-mode env behaviour (`PAYROLL_*` failure rates/modes) is unchanged by comparing the existing simulated-provider spec results.
