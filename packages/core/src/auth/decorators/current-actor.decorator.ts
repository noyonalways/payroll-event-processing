import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { REQUEST_ACTOR_KEY } from '../auth.constants';
import { AuthenticatedActor, AuthenticatedRequest } from '../authenticated-actor';

/**
 * Injects the authenticated caller — `{ userId, organizationId, role }` — resolved
 * from the verified access token by the global `JwtAuthGuard`.
 *
 * Handlers take the actor rather than a raw `organizationId` string so the tenancy
 * boundary is always traceable to an authenticated identity at the call site.
 *
 * Absence is a programming error (the route is `@Public()` but its handler expects
 * an actor), surfaced as a 401 rather than a non-null assertion.
 */
export const CurrentActor = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedActor => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    const actor = request[REQUEST_ACTOR_KEY];
    if (!actor) {
      throw new UnauthorizedException('No authenticated actor on this request');
    }
    return actor;
  },
);
