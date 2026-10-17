import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MembershipRole } from '@prisma/client';
import { REQUEST_ACTOR_KEY, ROLE_RANK, ROLES_KEY } from '../auth.constants';
import { AuthenticatedActor, AuthenticatedRequest } from '../authenticated-actor';

/**
 * Global role gate (role-enforcement design D1), registered as the SECOND
 * `APP_GUARD` in `AuthModule` — after `JwtAuthGuard`, so the ordering the
 * access-control spec requires holds by construction:
 *
 *   authentication (401) → tenant isolation (404, in services)
 *   → authorization (403, here).
 *
 * A route WITHOUT `@Roles()` metadata allows ANY authenticated actor — the
 * deliberate, documented default (reads, submission, session routes). A route
 * WITH metadata grants only callers whose token role is the declared minimum
 * or any higher role (`@Roles(ADMIN)` admits ADMIN and OWNER). The role comes
 * from the verified access token's `role` claim, which was resolved from the
 * membership row at mint time (tenancy spec) — no per-request DB read.
 *
 * The 403 fires BEFORE controller bodies run: a member probing another
 * organization's event through a gated operation gets the operation denial
 * (403), while an authorized caller probing the same id gets the tenant-driven
 * 404 from the service — resource-independent role denial never leaks
 * existence, and tenancy semantics stay untouched for elevated roles (design
 * D3).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<MembershipRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    // No declaration → any authenticated actor (the JWT guard already ran).
    if (!required || required.length === 0) {
      return true;
    }

    const httpRequest = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const actor = httpRequest[REQUEST_ACTOR_KEY] as AuthenticatedActor | undefined;

    // The JWT guard only lets authenticated requests past this point, so an
    // absent actor is a wiring bug, not a state a caller can reach — deny
    // closed rather than guess.
    const claimedRank = actor ? ROLE_RANK[actor.role] ?? 0 : 0;
    const minimumRank = Math.min(
      ...required.map((role) => ROLE_RANK[role] ?? Number.MAX_SAFE_INTEGER),
    );

    if (claimedRank >= minimumRank) {
      return true;
    }

    throw new ForbiddenException(
      `This operation requires the ${required.join(' or ')} role or higher`,
    );
  }
}
