# Route role-posture sweep (role-enforcement task 2.3/3.1)

Every controller in `@repo/core` at the moment this change landed. "Default" means: the route requires a valid access token (global `JwtAuthGuard`; `@Public()`
is the only opt-out) and accepts ANY authenticated role (`RolesGuard` finds no `@Roles()`
metadata). All routes are tenant-scoped regardless of role.

| Route | Posture | Declared via |
|---|---|---|
| `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout` | public | `@Public()` |
| `GET /auth/me` | any authenticated member | default |
| `GET /health` | public (orchestrator probe) | `@Public()` |
| `POST /events` | any authenticated member | default |
| `GET /events`, `GET /events/:id`, `GET /events/stream` (SSE) | any authenticated member | default |
| `POST /events/:id/retry`, `POST /events/:id/cancel` | **ADMIN+** | `@Roles(ADMIN)` |
| `POST /employees` | **ADMIN+** | `@Roles(ADMIN)` |
| `GET /employees`, `GET /employees/:id` | any authenticated member | default |
| `PATCH /employees/:id`, `DELETE /employees/:id` | **ADMIN+** | `@Roles(ADMIN)` |
| `POST /webhook-endpoints` | **ADMIN+** | `@Roles(ADMIN)` (sweep decision — endpoint configuration is an operational action on committed delivery targets, same class as directory mutations) |
| `PATCH /webhook-endpoints/:id`, `DELETE /webhook-endpoints/:id` | **ADMIN+** | `@Roles(ADMIN)` (sweep decision, as above) |
| `GET /webhook-deliveries/:id`, `GET /webhook-endpoints/:id/deliveries` | any authenticated member | default |

Every state-changing route now either matches the baseline matrix or carries an explicit
`@Roles()` declaration — the any-member default is load-bearing ONLY for reads, submission, and
session routes, exactly as the access-control spec's baseline defines it.

Deviations/notes recorded for future changes:

- `integrator-webhooks`' original proposal predates the matrix; the ADMIN gate on its config
  routes was added by THIS change's sweep (the e2e suites still pass — they mint OWNER sessions
  via `registerTenant`).
- `org-membership-management` has already planned its gates under this matrix: invitations at
  ADMIN+, role changes and member removal at OWNER+.
