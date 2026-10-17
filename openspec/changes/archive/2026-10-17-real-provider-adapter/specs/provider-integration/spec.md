# Spec Delta

## Purpose

Let each organization point its payroll event processing at a real external endpoint behind the
existing handler registry, while keeping the simulated provider as the tested default and the
retry/failure contracts untouched.

## ADDED Requirements

### Requirement: Each organization resolves one external provider
The system SHALL resolve, per organization, the provider that handlers dispatch the external
payroll operation to: an organization with an active `HTTP` configuration SHALL use the HTTP
adapter against its configured endpoint, and any organization without one SHALL use the
simulated provider. Configuration SHALL belong to exactly one organization and SHALL be
readable, updatable, and deletable only by that organization's OWNER-gated endpoints; the
resolution SHALL happen inside the worker's event processing and SHALL NOT require a restart or
redeploy.

#### Scenario: Organization without configuration keeps the simulated provider
- **WHEN** an event is processed for an organization with no HTTP provider configuration
- **THEN** the handler's external operation SHALL run through the simulated provider exactly as today

#### Scenario: Configuration takes effect without restart
- **WHEN** the OWNER activates an HTTP configuration and a subsequent event is processed
- **THEN** the external operation SHALL be delivered to the configured endpoint, not the simulated provider

#### Scenario: Configuration is tenant-scoped and credential-protected
- **WHEN** configuration is read back through the API
- **THEN** it SHALL expose the mode and endpoint but never the credential, and the credential SHALL be returned in full only by the write response that sets it

### Requirement: The HTTP adapter posts a documented operation contract with bounded latency
The HTTP adapter SHALL deliver each external payroll operation as a single `POST` to the
stored endpoint URL with the organization's credential in an authorization header and a JSON
body carrying the event's employee, type, sequence, payload fields, effect reference context,
and attempt number. The request SHALL time out within a bounded window (configurable, default
10 seconds). The endpoint SHALL be required to respond `2xx` with a JSON body containing a
non-empty provider `reference` string; a success SHALL surface that reference in the processing
result exactly as the simulated provider's reference does. The request/response schema SHALL be
published in the API documentation so a conforming external system can implement it.

#### Scenario: Successful external call returns a usable reference
- **WHEN** the configured endpoint responds `200` with `{ "reference": "ext-123" }`
- **THEN** the handler's processing result SHALL carry reference `ext-123` and the event SHALL commit `success` as usual

#### Scenario: Timeout is treated as transient
- **WHEN** the endpoint does not respond within the timeout window
- **THEN** the adapter SHALL throw an error of the transient failure class, the claim transaction SHALL roll back, and the event SHALL be retried by the queue

#### Scenario: Missing reference is treated as transient
- **WHEN** the endpoint responds `2xx` without a non-empty `reference`
- **THEN** the adapter SHALL throw an error of the transient failure class and no domain state SHALL be written

### Requirement: Protocol outcomes are classified into the existing failure classes
The HTTP adapter SHALL map protocol outcomes to the two failure classes that drive retry policy:
network errors, timeouts, and `5xx` responses SHALL raise transient failures; `4xx` responses
SHALL raise permanent failures that carry the provider's rejection detail as the failure reason.
Classification SHALL be identical in kind to the simulated provider's, so retry-with-backoff and
terminal `failed` behaviour (including the `event_attempts` audit row) are indistinguishable by
the rest of the system regardless of which provider ran.

#### Scenario: Server error retries with backoff
- **WHEN** the configured endpoint responds `503` to an operation
- **THEN** the event SHALL be treated exactly like a simulated transient failure: the claim rolls back and BullMQ retries with exponential backoff

#### Scenario: Business rejection fails permanently
- **WHEN** the configured endpoint responds `422` with a rejection body
- **THEN** the adapter SHALL raise a permanent failure carrying the rejection detail, the event SHALL commit `failed` with a FAILED attempt row, and no retry SHALL occur

#### Scenario: Domain state is never half-applied on provider failure
- **WHEN** the HTTP adapter raises either failure class during handler execution
- **THEN** no employee domain state for the event SHALL be committed (the provider call precedes the state write in the same transaction boundary)
