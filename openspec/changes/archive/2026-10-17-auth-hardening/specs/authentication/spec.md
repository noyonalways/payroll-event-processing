# Spec Delta

## Purpose

Rate-bound and lock the credential-guessing surface, make forgotten passwords recoverable
without weakening the existing no-enumeration posture, and stop auth-token rows from growing
forever.

## ADDED Requirements

### Requirement: A forgotten password can be reset through a single-use token
The system SHALL expose `POST /auth/forgot-password` (public) accepting an email, responding
identically (HTTP `202`, same body) whether or not the email has an account, and creating for
existing accounts a single-use password-reset token — stored as an undecryptable digest exactly
like refresh and invitation tokens — with a bounded validity (default 30 minutes). The system
SHALL expose `POST /auth/reset-password` (public) accepting the token and a new password meeting
the same strength policy as registration. On success the system SHALL set the new password
digest, invalidate the token, revoke ALL of the user's live refresh tokens, and clear any login
lockout. An expired, accepted, or unknown token SHALL be rejected with an opaque structured
error that does not distinguish the cases. Token hand-off to the user is out-of-band; the
system SHALL NOT require email delivery to satisfy this requirement.

#### Scenario: Reset completes and kills sessions
- **WHEN** a valid reset token with a strong new password is presented, while the user holds live sessions
- **THEN** the password SHALL be changed, every live refresh token of the user SHALL be revoked (a later refresh SHALL fail), and the response SHALL indicate success without revealing session details

#### Scenario: A reset token cannot be reused
- **WHEN** the same reset token is presented twice
- **THEN** exactly one reset SHALL succeed and the second SHALL be rejected with the opaque error

#### Scenario: Forgot-password never reveals account existence
- **WHEN** `POST /auth/forgot-password` is called for an email with an account and for one without
- **THEN** both responses SHALL be identical in status, body, and timing profile, and the account-less call SHALL create nothing

### Requirement: Repeated failed logins lock the account temporarily
The system SHALL count consecutive failed login attempts per account and, when the count reaches
a configurable threshold (default 5) within its window, SHALL lock the account for a
configurable cool-down (default 15 minutes). While locked, login attempts SHALL be rejected with
HTTP `429` and a `Retry-After` header, with the SAME error body shape regardless of whether the
account exists — the response SHALL NOT reveal account existence. A successful login SHALL reset
the failure counter; an expired lock SHALL end automatically; a password reset SHALL clear both
counter and lock. Registration SHALL NOT be affected by another account's lockout.

#### Scenario: Threshold reached locks the account
- **WHEN** the configured number of consecutive failed logins occurs for one account
- **THEN** further login attempts for that account SHALL receive HTTP `429` with `Retry-After` until the cool-down elapses

#### Scenario: Correct password during lockout is still rejected
- **WHEN** the correct password is presented while the account is locked
- **THEN** the login SHALL still be rejected with `429` and no session SHALL be issued

#### Scenario: Lockout clears on success or expiry
- **WHEN** the lock expires and the correct password is then presented
- **THEN** the login SHALL succeed and the failure counter SHALL be cleared

#### Scenario: Lockout response does not expose other accounts
- **WHEN** login attempts hit an unknown email while some other account is locked
- **THEN** the unknown-email attempts SHALL keep the standard credential-failure response, never a lock-specific one

### Requirement: Public endpoints are rate limited
The system SHALL apply request throttling across the API using configurable window-based limits:
strict per-client limits on the unauthenticated credential surface (`/auth/login`,
`/auth/register`, `/auth/forgot-password`, `/auth/reset-password`, `/invitations/accept`), and a
generous per-client default on all other routes. An over-limit request SHALL be rejected with
HTTP `429`, the structured error body, and `Retry-After`, before any credential or token
processing. The client key SHALL derive from the request client address as configured for the
deployment's proxy topology (trust setting configurable). Rate-limit rejections SHALL be
observable without tenant data.

#### Scenario: Credential brute force is throttled
- **WHEN** the login endpoint receives more requests per client than the strict limit allows within its window
- **THEN** excess requests SHALL receive HTTP `429` with `Retry-After` before password verification runs

#### Scenario: Normal usage is unaffected
- **WHEN** a client operates within the generous default limit (event reads, submissions, SSE stream)
- **THEN** no request SHALL be throttled

### Requirement: Expired auth credentials are swept from storage
The system SHALL periodically delete refresh-token rows whose token is expired, or revoked and
older than a configurable retention period (default 7 days after revocation). The system SHALL
equally delete expired password-reset tokens past their validity plus the same retention
period. The sweep SHALL run in the background worker on a configurable interval, SHALL be
bounded per run, and a sweep failure SHALL log structurally and retry at the next interval
without affecting any other processing. Reuse detection and single-use semantics SHALL NOT
depend on swept rows (they operate only on tokens still within their validity or retention
lifetime).

#### Scenario: Revoked families age out
- **WHEN** refresh tokens have been expired for longer than the retention window
- **THEN** the sweep SHALL delete them and a subsequent sweep SHALL not re-raise

#### Scenario: Live tokens are never swept
- **WHEN** a refresh token is unexpired and unrevoked
- **THEN** the sweep SHALL NOT delete it and normal refresh SHALL continue to work across sweeps

#### Scenario: Sweep failure is contained
- **WHEN** the database is unreachable during a sweep run
- **THEN** the error SHALL be logged structurally, no other scheduled work SHALL be disturbed, and the next interval SHALL retry
