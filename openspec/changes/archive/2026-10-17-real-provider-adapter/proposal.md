# Proposal

## Why

Every event's "external payroll operation" is hard-wired to `SimulatedPayrollProvider` — handlers
inject it directly, so the processing pipeline can never affect a real external system. The
handler registry, transactional claim, domain effects, and retry/failure contracts are all done,
which is exactly why the provider is now the queued seam to open (item 9): swap the
implementation behind the registry per organization, keeping the reliability contracts intact.

## What Changes

- **Provider seam**: handlers depend on a new `ExternalPayrollProvider` interface
  (`apply(input, tx) → { reference }`) instead of the concrete simulated provider; the provider
  resolved per event's organization (via a resolver service) supplies the implementation.
- **Per-organization provider configuration**: `PATCH`-able org-level config storing the
  external endpoint base URL and an API credential, with mode `SIMULATED` (default) or `HTTP`.
  Management API gated to the organization's OWNers (motor of change: "replace the simulated
  provider ... per-organization external endpoint config").
- **HTTP adapter**: implements the same provider contract by POSTing the operation to the
  configured endpoint with the credential (Authorization header), a bounded timeout, and a
  strict response contract (JSON body carrying a reference); protocol outcomes are classified
  into the existing transient/permanent failure classes (5xx/network/timeout ⇒ transient, 4xx
  business rejection ⇒ permanent), so BullMQ retry semantics are untouched.
- **Simulated provider stays** the default for organizations without HTTP configuration — the
  demo failure-rate/mode behaviour is unchanged, demo scenarios in the UI keep working.
- The external operation contract is published in Swagger so a conforming external system (or
  stub) can be integrated — like the webhook receiver contract, verification SDKs are left to
  consumers.

## Capabilities

### New Capabilities
- `provider-integration`: Per-organization external payroll provider configuration and the HTTP
  adapter — resolution precedence, request/response contract, timeout, and transient/permanent
  classification of protocol outcomes.

### Modified Capabilities
- `event-processing`: Handlers dispatch the external operation through the resolved
  per-organization provider rather than the wired implementation; the simulated provider is
  renamed in the contract to what it already is — the default provider (its rates, modes, and
  demo scenarios are unchanged).

## Impact

- **DB**: new `provider_configs` table (+ migration): per-organization endpoint URL, credential,
  and mode; no changes to existing tables or to the claim/attempt/audit paths.
- **Processing**: new resolver + HTTP adapter in `packages/core/src/processing/` (provider
  module); handlers change their injected dependency from the concrete provider to the interface
  — the one behavioural seam in this change.
- **API**: new provider-config endpoints (OWNER-gated per `access-control`), Swagger-documented.
- **Reliability**: transient/permanent classification (concept 1) and exactly-once terminal
  commits (concept 5) are preserved — the adapter throws the existing failure classes, so the
  claim transaction, retries, and audit rows behave identically; a provider failure can never
  commit a half-applied domain effect (the handler order — provider call first, state write
  second — is unchanged).
- **Security**: credentials stored per organization, returned once on write, never logged or
  exposed in reads.

## Non-goals

- No concrete third-party integration implementation (no vendor SDK) — the HTTP adapter defines
  and documents the contract a provider system must satisfy.
- No per-event-type routing of providers beyond the organization level.
- No UI for provider configuration (API-only this change; demo flows are untouched).
- No change to failure-rate/deterministic-mode env behaviour of the simulated provider.
