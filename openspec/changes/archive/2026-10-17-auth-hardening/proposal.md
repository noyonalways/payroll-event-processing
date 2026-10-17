# Proposal

## Why

The authentication layer has solid fundamentals (salted digests, rotation with reuse detection,
opaque errors) but no defence against bulk password guessing: login is unthrottled, there is no
account lockout, a forgotten password is unrecoverable, and `refresh_tokens` rows (including
revoked families) accumulate forever. Item 11 groups exactly these into the hardening change.

## What Changes

- **Password reset**: `POST /auth/forgot-password` (public, anti-enumeration: identical response
  whether or not the email exists) plus `POST /auth/reset-password` (single-use hashed token,
  bounded validity). A successful reset revokes ALL of the user's refresh tokens, and the
  hand-off is out-of-band like invitations — no email infrastructure.
- **Account lockout**: repeated failed logins for one account (per email, threshold and window
  configurable) lock the account for a bounded cool-down; locked and normal failures are
  indistinguishable in the response body, with `Retry-After` conveyed by header only.
  Successful login or an expired lock clears the counter.
- **Rate limiting**: `@nestjs/throttler` globally — one strict profile on the public auth and
  invite-acceptance routes (per-IP), a generous default for everything else, `429` with the
  structured error body and `Retry-After`; proxy-trust behaviour configurable for correct
  per-client keys.
- **Refresh-token retention sweep**: a periodic worker job deletes refresh-token rows that are
  expired or revoked-and-aged-out (retention window configurable, default 7 days afterwards),
  and equally expires stale password-reset tokens — reuse detection is unaffected because it
  keys on presented-token lookups during their lifetime, not on tombstones.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities
- `authentication`: Adds hardening requirements alongside the existing session model — password
  reset, account lockout, request throttling on the public auth surface, and refresh-token
  retention. No existing requirement text changes: rotation, reuse detection, rotation-triggered
  family revocation, and opaque error behaviour are all preserved as-is.

## Impact

- **DB**: `User` gains `failedLoginCount`/`lockedUntil`; new `password_reset_tokens` table
  (hashed token, single-use, expiry) — one migration. `refresh_tokens` unchanged; the sweep
  only deletes rows.
- **API**: two new public auth routes; throttling annotations app-wide; Swagger'd.
- **Worker**: one new low-frequency sweep job alongside the existing interval services.
- **Security posture**: guessing becomes rate-bounded AND lockout-bounded; credential reset does
  not re-open stolen sessions (refresh family revoked on reset).
- **Existing specs**: the no-enumeration and opaque-error requirements continue to hold —
  lockout and throttle responses are shaped to keep them true.

## Non-goals

- Email/SMS delivery of reset links (out-of-band hand-off, like `org-membership-management`).
- CAPTCHAs, MFA/2FA, password history/rotation policies, and session device listing.
- IP reputation or distributed lockout stores (per-account counters + in-process/IP-window
  throttling are the baseline).
