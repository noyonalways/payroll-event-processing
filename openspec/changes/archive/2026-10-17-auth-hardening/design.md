# Design

## Context

`TokenService.rotate` (`packages/core/src/auth/token.service.ts`) already revokes the whole token
family on replay; `PasswordService` owns the argon/bcrypt digest policy; login resolves
membership with opaque `UnauthorizedException('Invalid email or password')`; registration enforces
the 12-character password minimum on the frontend and (per the authentication spec) digest-only
storage. Tokens are stored as SHA-256 digests of high-entropy values — the pattern
`password_reset_tokens` will reuse. The worker hosts interval services (heartbeat, and the
webhook relay when `integrator-webhooks` has landed). `@nestjs/throttler` is not yet a
dependency anywhere.

## Goals / Non-Goals

**Goals:**

- Guessing becomes bounded twice (per-IP throttle + per-account lockout) with zero weakening of
  the existing opaque-error/no-enumeration requirements.
- Reset never opens a stolen session door: family-wide refresh revocation on reset.
- The sweep reuses the proven patterns: hashed lookup, guarded transitions, bounded interval job.

**Non-Goals:**

- Email delivery, MFA/CAPTCHA, distributed throttling stores, device/session dashboards.

## Decisions

### D1 — Account lockout on the `User` row, threshold in service logic

Migration adds `failed_login_count INT NOT NULL DEFAULT 0` and `locked_until TIMESTAMPTZ` to
`users`. Logic in `auth.service.ts` login path (new private `assertNotLocked` /
`recordFailure` / `clearFailures`): increment on password mismatch (`updateMany
WHERE locked_until IS NULL OR locked_until < now()`), set `locked_until = now() + lockout` at
threshold (`AUTH_LOCKOUT_THRESHOLD` default 5, `AUTH_LOCKOUT_MINUTES` default 15); locked
requests → `HttpException 429` with `Retry-After` (generic `ThrottlerException`-shaped body) —
never `401`, so the account's existence is not confirmed by a distinct status for wrong/unknown
emails (existing no-enumeration requirement is preserved by shape: unknown emails keep plain
`401`). Registration/invite-acceptance password failures do NOT feed lockout (own counters).

### D2 — Password reset follows the invitation-token blueprint

New `password_reset_tokens` table: `id`, `user_id` (FK), `token_hash` (unique), `expires_at`,
`used_at` (null), `created_at`. `POST /auth/forgot-password`: unknown email ⇒ identical `202`
(no row); known email ⇒ issue token (32 bytes base64url), invalidate prior unused tokens for the
user. `POST /auth/reset-password` (public, DTO = token + password): hash-lookup, expiry check,
guarded `used_at` transition (`updateMany WHERE used_at IS NULL` — loser aborts), digest update
via `PasswordService`, then revoke the user's live refresh tokens (one `updateMany` on
`revokedAt IS NULL`) and clear lockout fields — all in one transaction. Access-token staleness
window is bounded by the existing short TTL (authentication spec) — same posture as
role-removal enforcement, no new invalidation channel.

### D3 — `@nestjs/throttler` v6, global guard with per-route strict profiles

`ThrottlerModule.forRoot` in `app.module.ts` with `AUTH_THROTTLE_LIMIT/TTL` (default 5 per
minute) matched to public auth routes + `/invitations/accept` via `@Throttle()` overrides, and
`DEFAULT_THROTTLE_LIMIT/TTL` (default 100 per minute) globally; `skip` for `GET /health` and
`GET /metrics`/worker listener (scrapes must never 429). Guard order: throttler runs BEFORE JWT
(express global-guard order) so over-limit unauthenticated requests cost nothing — this is also
what makes the throttle a DoS shield, and it precedes credential verification for the
brute-force scenario. Client key = `req.ip` with
`TRUST_PROXY`-configurable Express trust setting so keying survives reverse proxies.

### D4 — Sweep job in the worker, one bounded delete per tick

New `auth-sweep.service.ts` interval service in the worker composition root (mirrors
`heartbeat.service.ts`): every `AUTH_SWEEP_INTERVAL_MS` (default 3600000) run two bounded
`deleteMany` statements — refresh tokens where (`expires_at < now()`) OR (`revoked_at IS NOT
NULL AND revoked_at < now() - RETENTION`) with `AUTH_TOKEN_RETENTION_DAYS` default 7; password
reset tokens where (`expires_at < now() - RETENTION`). `retention` exists so reuse-detection
tombstones (revoked family members) survive an attack-investigation window before deletion.
Try/catch with structured log + next-tick retry (spec), count of swept rows logged. Live-token
safety is structural: the WHERE clauses can only match expired/revoked rows.

### D5 — Throttle + lockout interplay (documented, tested)

Per-IP throttle fires first (shield against distributed-by-IP guessing across accounts);
per-account lockout then bounds single-account attacks that rotate IPs. `429` from either
mechanism is body-shape-identical (structured error) — headers differ (`Retry-After` present in
both). Metrics integration stays out of this change's code paths beyond the standard HTTP
status-class series observability already provides.

## Risks / Trade-offs

- [IP-keyed throttling punishes shared egress (offices, CGNAT)] → generous default limit + strict
  limits only on unauthenticated credential routes; limits are configuration.
- [In-process throttle counters don't share state across replicas] → acceptable baseline per
  replica; the per-account DB lockout is the cross-replica bound; distributed store is a
  non-goal.
- [Reset token in wrong hands before use] → single-use + short TTL + hashed storage + family
  revocation exactly mirrors invite handling; out-of-band hand-off is an accepted, documented
  posture.
- [Sweep deletes evidence during incident] → retention window (7 days) keeps revoked rows
  queryable past immediate cleanup; configurable to widen.

## Migration Plan

One migration (User columns + new table), deployed before or with the app release; new public
routes + global throttler activate on deploy. Throttler thresholds default to permissive enough
that existing e2e suites stay green (strict route limits configurable per test env). Rollback:
revert module wiring; migration is additive.

## Open Questions

None — email delivery remains explicitly out by scope; threshold numbers are documented defaults,
not open design.
