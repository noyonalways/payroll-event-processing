## ADDED Requirements

### Requirement: Idempotency-Key is parsed and validated from the request header
The idempotency layer SHALL provide an `@IdempotencyKey()` parameter decorator that reads the `Idempotency-Key` request header. The key SHALL be required: a missing header SHALL result in HTTP `400` with a structured error body, and no operation SHALL run. The value SHALL be trimmed of surrounding whitespace and SHALL be a printable-ASCII string of at most 128 characters; a blank, over-length, or non-printable value SHALL result in HTTP `400`. On success the decorator SHALL expose the trimmed, validated key to the controller handler.

#### Scenario: Missing header rejected
- **WHEN** a request is made to a protected endpoint without an `Idempotency-Key` header
- **THEN** the response SHALL be HTTP `400` with a structured error body and no operation SHALL run

#### Scenario: Blank header rejected
- **WHEN** a request's `Idempotency-Key` header contains only whitespace
- **THEN** the response SHALL be HTTP `400` with a structured error body and no operation SHALL run

#### Scenario: Over-length key rejected
- **WHEN** a request's `Idempotency-Key` header exceeds 128 printable-ASCII characters
- **THEN** the response SHALL be HTTP `400` with a structured error body and no operation SHALL run

#### Scenario: Valid key is accepted and exposed
- **WHEN** a request's `Idempotency-Key` header is a printable-ASCII string of 128 or fewer characters, with optional surrounding whitespace
- **THEN** the endpoint SHALL run normally and the handler SHALL receive the trimmed, validated key

### Requirement: New operations store their response atomically and dedupe into it
The layer SHALL expose `IdempotencyService.execute(scope, key, op)` where `op` performs the operation's state changes and returns `{ status, body }`. If the store contains a non-expired record for `(scope, key)`, `execute` SHALL return its stored `{ status, body }` without invoking `op` again. Otherwise `execute` SHALL invoke `op` and persist the returned response into the `idempotency_records` store. The operation's state changes and the response record SHALL commit in the same transaction, so a crash or failure before commit SHALL leave no response record and no operation side effects. When two concurrent requests race on the same `(scope, key)`, the store's unique key SHALL reject the loser and `execute` SHALL return the winner's stored response rather than an error.

#### Scenario: First request stores the response
- **WHEN** `execute` is invoked for a `(scope, key)` with no existing record
- **THEN** `op` SHALL run once, and its `{ status, body }` SHALL be persisted and returned

#### Scenario: Duplicate request replays the stored response
- **WHEN** `execute` is invoked again for the same `(scope, key)` while the stored record is unexpired
- **THEN** `op` SHALL NOT run and the stored `{ status, body }` SHALL be returned exactly

#### Scenario: Concurrent duplicate returns the stored response
- **WHEN** two requests with the same `(scope, key)` and no existing record are executed concurrently
- **THEN** `op` SHALL run exactly once and both callers SHALL receive the stored `{ status, body }`

#### Scenario: Failure before commit leaves no record
- **WHEN** `op` throws before the transaction commits
- **THEN** no `idempotency_records` row SHALL exist for `(scope, key)` and `execute` SHALL propagate the error

### Requirement: Stored responses expire and are purged
Each stored response SHALL carry an expiry time equal to its creation time plus `IDEMPOTENCY_TTL_SECONDS` (default `86400`, i.e. 24 hours). A lookup SHALL treat an expired record as absent, and a subsequent invocation for that `(scope, key)` SHALL run `op` again and store a fresh response. The layer SHALL periodically delete expired records so the store size stays bounded. An expired-record lookup SHALL be observable as a distinct outcome.

#### Scenario: Key reuse after expiry starts a new operation
- **WHEN** a stored response for `(scope, key)` has passed its expiry time and `execute` is invoked again
- **THEN** `op` SHALL run again and a new response SHALL be stored, replacing the expired record

#### Scenario: Expired records are purged
- **WHEN** the sweep runs and records have passed their expiry time
- **THEN** the expired records SHALL be deleted from the store and SHALL no longer appear in lookups

#### Scenario: Expired record lookup is logged distinctly
- **WHEN** a lookup finds a record whose expiry time has passed
- **THEN** the layer SHALL log the decision with the `expired` outcome before treating it as absent

### Requirement: Scopes isolate deduplication domains
The `(scope, key)` pair, not the key alone, SHALL define idempotency identity. Two operations in different scopes SHALL be deduplicated independently: the same key value used in two scopes SHALL NOT cause either operation to be replayed against the other's stored response.

#### Scenario: Same key in different scopes does not dedupe
- **WHEN** `execute` stores a response for key `k` in scope `a`, and `execute` is then invoked with the same key `k` in scope `b`
- **THEN** the operation in scope `b` SHALL run normally and SHALL NOT receive scope `a`'s stored response

### Requirement: The layer exposes structured observability
Every deduplication decision SHALL be logged with structured context identifying the scope, the key, and one of the outcomes `stored` (new response persisted), `replay` (non-expired stored response served), `expired` (expired record treated as absent), or `race` (concurrent duplicate; the winner's stored response was served), plus the returned HTTP status code. Keys SHALL be logged; payloads and response bodies SHALL NOT be logged.

#### Scenario: First request logs stored
- **WHEN** an invocation stores a new response for `(scope, key)`
- **THEN** a log line SHALL be emitted carrying the scope, the key, and the outcome `stored`

#### Scenario: Duplicate logs replay
- **WHEN** an invocation serves a stored response for `(scope, key)`
- **THEN** a log line SHALL be emitted carrying the scope, the key, the outcome `replay`, and the stored HTTP status