# webhook-delivery Specification

## Purpose

Deliver signed webhook notifications to per-organization endpoints whenever a payroll event
reaches a terminal state, through a transactional outbox that guarantees every committed terminal
transition produces a delivery intent, with retry and dead-letter semantics for unreliable consumers.

## Requirements

### Requirement: Organizations configure webhook endpoints

The system SHALL maintain a `webhook_endpoints` configuration in which every endpoint record
belongs to exactly one organization. An endpoint SHALL carry an HTTPS callback URL, an
organization-unique label, an active flag, a system-generated signing secret, and
creation/update timestamps. Only authenticated callers of the owning organization SHALL be able
to create, list, update, or delete its endpoints. The signing secret SHALL be returned in full
exactly once, at creation time, and SHALL never be exposed by list or read operations.

#### Scenario: Endpoint is scoped to the caller's organization
- **WHEN** an authenticated client registers a webhook endpoint
- **THEN** the stored record SHALL belong to the organization of the client's access token, and
  another organization's client SHALL not see or modify it

#### Scenario: Signing secret is shown once
- **WHEN** an endpoint is created and afterwards listed or read
- **THEN** the creation response SHALL include the signing secret, and every later response SHALL
  omit it
### Requirement: Every terminal transition produces a delivery intent

The system SHALL maintain an append-only `webhook_deliveries` outbox in which every terminal
event transition (`success`, `failed`, `cancelled`) committed for an organization with at least
one active webhook endpoint SHALL create one pending delivery row per active endpoint. Each row
SHALL record the target endpoint, the event, the terminal status, the full notification payload
to deliver, and a `pending` state. The delivery intent row SHALL be created in the SAME database
transaction as the terminal transition, so a transition commits with its intent or not at all.
Events in organizations without any active endpoint SHALL produce no delivery rows.

#### Scenario: Terminal commit carries its delivery intent
- **WHEN** the worker commits `processing → success` for an event of an organization with an
  active webhook endpoint
- **THEN** the same committed transaction SHALL contain a pending `webhook_deliveries` row for
  that event and endpoint

#### Scenario: Terminal commit without endpoints produces no intent
- **WHEN** an event reaches a terminal state in an organization with no active webhook endpoint
- **THEN** no delivery row SHALL be created and no crash or error SHALL occur

#### Scenario: Delivery failure never rolls back the event
- **WHEN** a delivery later fails permanently
- **THEN** the event's terminal state and business effects SHALL remain committed and unchanged
### Requirement: Deliveries are signed and delivered at least once

The system SHALL deliver each pending delivery row by HTTPS `POST` to the endpoint URL with a
JSON body carrying the event identifier, organization identifier, employee identifier, event type,
sequence, terminal status, the processing result or failure reason, and the terminal timestamp.
The request SHALL include a signature header computed as HMAC-SHA256 over the raw request body,
keyed with the endpoint's signing secret, plus a delivery identifier and timestamp headers.
Consumers SHALL be able to verify authenticity and reject forgeries. The system SHALL treat a
delivery as observed (succeeded) when the endpoint responds `2xx` within the request timeout. At
least-one delivery SHALL be permitted: an endpoint MAY receive the same notification more than
once (for example after a crash between successful POST and delivery acknowledgement), and the
payload's event identifier plus terminal status lets consumers deduplicate.

#### Scenario: Signed delivery to a healthy endpoint
- **WHEN** the relay delivers a pending row to an endpoint that responds `200`
- **THEN** the request body SHALL verify against the endpoint's signing secret via HMAC-SHA256,
  and the delivery SHALL be marked delivered

#### Scenario: Duplicate delivery is detectable
- **WHEN** the same notification is delivered twice due to a relay crash after a successful POST
  but before acknowledgement
- **THEN** both requests SHALL carry the same event identifier and terminal status, letting the
  consumer deduplicate idempotently
### Requirement: Transient delivery failures retry with backoff, then dead-letter

The system SHALL classify delivery failures: network errors, timeouts, and `5xx` responses are
transient; `4xx` responses are permanent. A transient failure SHALL retry with exponential
backoff up to a bounded number of attempts, then dead-letter the delivery. A permanent rejection
SHALL dead-letter the delivery without retrying. Dead-lettered and exhausted deliveries SHALL
remain queryable with their attempt trail (attempt number, response status or error, timestamp)
alongside delivered ones. Delivery attempts SHALL NOT delay, block, or roll back payroll event
processing.

#### Scenario: Temporary outage is survived
- **WHEN** an endpoint responds `503` for the first delivery attempts and then `200`
- **THEN** the delivery SHALL retry with increasing delay and finally be marked delivered

#### Scenario: Permanent rejection dead-letters without retry
- **WHEN** an endpoint responds `410 Gone` to a delivery
- **THEN** the delivery SHALL be marked dead-lettered without further attempts, and the attempt
  SHALL be recorded

#### Scenario: Exhausted retries dead-letter
- **WHEN** all delivery attempts for a pending row fail transiently
- **THEN** the delivery SHALL be marked dead-lettered, its attempt trail SHALL be queryable, and
  the related event's terminal state SHALL be unaffected
### Requirement: Delivery status is observable

The system SHALL expose read endpoints for an organization's webhook deliveries, including
delivery state (`pending`, `delivered`, `dead-lettered`), the target endpoint, the delivered
event and terminal status, and the attempt trail. Only authenticated callers of the owning
organization SHALL be able to read its deliveries.

#### Scenario: Integrator inspects delivery health
- **WHEN** an authenticated client queries deliveries for one of its webhook endpoints
- **THEN** the response SHALL list the organization's deliveries with state and attempt trail
