# authentication Specification

## Purpose
Identifies who is calling the API and which organization they are acting in. Registration creates an organization with its first owner, credentials are verified without revealing whether an account exists, and sessions are carried by a short-lived signed access token plus a single-use refresh token that can actually be revoked. Every route is authenticated unless it explicitly opts out.

## Requirements

### Requirement: Registration creates an organization with its owner
The system SHALL expose `POST /auth/register` accepting `email`, `password`, `organizationName`, and an optional `name`. It SHALL create an organization, the user account, and an `OWNER` membership binding them, in one atomic operation, and SHALL return HTTP `201` with a session for that organization. Registration SHALL always create a NEW organization: the system SHALL NOT provide a way to join an existing organization without an invitation. An email that already has an account SHALL be rejected with HTTP `409`. A password shorter than 12 characters SHALL be rejected with HTTP `400`.

#### Scenario: Owner registers a new organization
- **WHEN** a client posts a valid `email`, `password`, `organizationName`, and `name` to `/auth/register`
- **THEN** the response SHALL be HTTP `201` carrying an `accessToken`, a `refreshToken`, the new organization's `id`/`name`/`slug`, the user's `id`/`email`, and a `role` of `OWNER`

#### Scenario: Duplicate email rejected
- **WHEN** a client registers with an email that already has an account
- **THEN** the response SHALL be HTTP `409` and the request SHALL NOT create an organization, a user, or a membership

#### Scenario: Weak password rejected
- **WHEN** a client registers with a password shorter than 12 characters
- **THEN** the response SHALL be HTTP `400` and no account SHALL be created

#### Scenario: Organizations may share a display name
- **WHEN** two clients register organizations with the same `organizationName`
- **THEN** both SHALL succeed with distinct organization identifiers and distinct `slug` values

### Requirement: Credentials are verified without revealing account existence
The system SHALL expose `POST /auth/login` accepting `email` and `password` plus an optional `organizationId`. A wrong password and an email with no account SHALL both be rejected with the same HTTP `401` and an identical error body, and the system SHALL perform a comparable amount of work in both cases so the two cannot be distinguished by response time. A login for an account that belongs to several organizations SHALL be rejected with HTTP `400` unless `organizationId` names one of them.

#### Scenario: Valid credentials produce a session
- **WHEN** a client submits an existing account's correct email and password
- **THEN** the response SHALL be HTTP `200` carrying an access token, a refresh token, and the organization and role the session is bound to

#### Scenario: Wrong password and unknown email are indistinguishable
- **WHEN** a client submits a wrong password for an existing account, and separately submits an email with no account
- **THEN** both responses SHALL be HTTP `401` with the same error body shape

#### Scenario: Ambiguous membership requires an organization
- **WHEN** a client whose account belongs to two organizations logs in without `organizationId`
- **THEN** the response SHALL be HTTP `400` and SHALL NOT issue a session for an arbitrary organization

#### Scenario: Naming an organization the account does not belong to fails as unauthorized
- **WHEN** a client logs in with valid credentials and an `organizationId` they are not a member of
- **THEN** the response SHALL be HTTP `401` and SHALL NOT disclose whether that organization exists

### Requirement: Sessions use short-lived access tokens and revocable refresh tokens
A successful register, login, or refresh SHALL return an access token and a refresh token. The access token SHALL be a signed token carrying the user identifier, the organization identifier, and the role, and SHALL expire after `AUTH_ACCESS_TOKEN_TTL` (default `15m`). The refresh token SHALL be an opaque random value that the system stores only as a digest, and SHALL expire after `AUTH_REFRESH_TOKEN_TTL_DAYS` (default `30`). The session SHALL be bound to exactly one organization, recorded with the refresh token, so a refresh cannot move a session to a different organization. The system SHALL NOT return a refresh token anywhere except the register, login, and refresh responses.

#### Scenario: Access token carries the tenant identity
- **WHEN** a client authenticates successfully
- **THEN** the returned access token SHALL be accepted on a protected endpoint and SHALL resolve the user, organization, and role it was issued for

#### Scenario: Refresh token is not recoverable
- **WHEN** a session has been issued
- **THEN** the system SHALL NOT be able to return that refresh token value again except as the result of a rotation

#### Scenario: Session cannot change organization on refresh
- **WHEN** a client refreshes a session that was issued for organization A
- **THEN** the new access token SHALL be scoped to organization A

### Requirement: Refresh rotates the session and detects reuse
The system SHALL expose `POST /auth/refresh` accepting a refresh token. A successful refresh SHALL consume the presented token and return a new access/refresh pair; the presented value SHALL NOT be usable again. Before issuing the new session the system SHALL re-check that the user is still a member of the session's organization, and SHALL reject the refresh with HTTP `401` if the membership no longer exists. Presenting an already-consumed refresh token SHALL be treated as reuse: the system SHALL revoke every live refresh token for that user and reject the request with HTTP `401`.

#### Scenario: Refresh returns a new pair and retires the old token
- **WHEN** a client refreshes with a valid unconsumed refresh token
- **THEN** the response SHALL be HTTP `200` with a new access token and a new refresh token, and the previously presented refresh token SHALL be rejected if presented again

#### Scenario: Removed member cannot refresh
- **WHEN** a user's membership in the session's organization has been removed and they attempt to refresh
- **THEN** the response SHALL be HTTP `401` and no new session SHALL be issued

#### Scenario: Reuse revokes the token family
- **WHEN** a client presents a refresh token that was already consumed by an earlier refresh
- **THEN** the response SHALL be HTTP `401` and every live refresh token for that user SHALL be revoked

#### Scenario: Unknown or expired refresh token rejected
- **WHEN** a client presents a refresh token that is unknown, expired, or malformed
- **THEN** the response SHALL be HTTP `401`

### Requirement: Sign-out revokes the session's refresh token
The system SHALL expose `POST /auth/logout` accepting a refresh token, and SHALL revoke it. The endpoint SHALL always respond HTTP `204`, including for an unknown or already-revoked token, so a client can clear its session locally without handling an error and the response cannot be used to probe whether a token was real.

#### Scenario: Logout revokes the token
- **WHEN** a client logs out with a valid refresh token and then attempts to refresh with it
- **THEN** the logout response SHALL be HTTP `204` and the subsequent refresh SHALL be rejected with HTTP `401`

#### Scenario: Logout of an unknown token still succeeds
- **WHEN** a client logs out with a token that was never issued or was already revoked
- **THEN** the response SHALL be HTTP `204`

### Requirement: Every route requires a valid access token unless explicitly public
The system SHALL authenticate every request by default. A request to a route that is not explicitly public SHALL be rejected with HTTP `401` unless it carries a valid, unexpired access token in an `Authorization: Bearer <token>` header. A refresh token presented as an access token SHALL be rejected. Only the health endpoint, the authentication entry points (register, login, refresh, logout), and the API documentation SHALL be reachable without an access token.

#### Scenario: Missing token rejected
- **WHEN** a client calls a protected endpoint without an `Authorization` header
- **THEN** the response SHALL be HTTP `401` and no data SHALL be returned

#### Scenario: Invalid or expired token rejected
- **WHEN** a client calls a protected endpoint with a malformed, tampered, expired, or foreign-signed token
- **THEN** the response SHALL be HTTP `401` with an error body that does not distinguish which of those cases applied

#### Scenario: Refresh token is not accepted as an access token
- **WHEN** a client presents a refresh token in the `Authorization` header of a protected endpoint
- **THEN** the response SHALL be HTTP `401`

#### Scenario: Public routes stay reachable
- **WHEN** a client calls the health endpoint, or registers, logs in, refreshes, or logs out, without an access token
- **THEN** the request SHALL be processed without an authentication error

### Requirement: The caller's identity can be read
The system SHALL expose `GET /auth/me`, requiring a valid access token, returning the authenticated user's `id`, `email`, and `name`, the organization their session is scoped to (`id`, `name`, `slug`), and the role they hold there. The endpoint SHALL NOT return credentials of any kind.

#### Scenario: Current identity returned
- **WHEN** an authenticated client calls `GET /auth/me`
- **THEN** the response SHALL be HTTP `200` carrying the user, the organization the token is scoped to, and the role

#### Scenario: Identity reflects the token's organization
- **WHEN** a user who belongs to two organizations calls `GET /auth/me` with a token issued for one of them
- **THEN** the response SHALL report the organization that token was issued for

### Requirement: Passwords are stored only as salted one-way digests
The system SHALL store user passwords exclusively as salted one-way digests produced by a memory-hard key derivation function, and SHALL verify a presented password in constant time with respect to the stored digest. The cost parameters SHALL be recorded alongside each digest so they can be strengthened later without invalidating existing credentials. Plaintext passwords SHALL never be persisted or logged.

#### Scenario: Password is not recoverable from storage
- **WHEN** a user account exists
- **THEN** no stored value SHALL permit the original password to be recovered, and each stored digest SHALL be salted so equal passwords produce different digests

#### Scenario: Stored digest parameters are honoured
- **WHEN** a password is verified against a digest recorded with specific cost parameters
- **THEN** the verification SHALL use those recorded parameters rather than whatever the current defaults are

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
