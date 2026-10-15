import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import {
  ACCESS_TOKEN_TYPE,
  BEARER_PREFIX,
  IS_PUBLIC_KEY,
  REQUEST_ACTOR_KEY,
} from '../auth.constants';
import { AccessTokenClaims, AuthenticatedRequest } from '../authenticated-actor';

/**
 * Global authentication guard, registered as an `APP_GUARD` in `AuthModule`.
 *
 * Deny-by-default: every route requires a valid access token unless it carries
 * `@Public()`. Registration and login are public by necessity; `POST /events` and
 * `GET /events/:id` are protected implicitly — no per-controller opt-in to forget.
 *
 * The tenant identity comes from the SIGNED `org` claim, never from a header,
 * query parameter, or body field. That is what makes the boundary trustworthy:
 * a caller can only act in an organization they hold a token for, and editing the
 * request cannot widen that.
 *
 * Verification is stateless (no database read per request), which is why access
 * tokens are short-lived and the refresh path re-checks the membership row
 * (design D4).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwtService: JwtService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.extractBearerToken(request.headers.authorization);

    if (!token) {
      throw new UnauthorizedException(
        'Missing bearer token: send an Authorization: Bearer <accessToken> header',
      );
    }

    let claims: AccessTokenClaims;
    try {
      claims = await this.jwtService.verifyAsync<AccessTokenClaims>(token);
    } catch {
      // Expired, tampered with, or signed by a different secret — one opaque
      // message so the response never distinguishes the cases to a caller.
      throw new UnauthorizedException('Invalid or expired access token');
    }

    // A refresh token is validly signed, so without this check it would be
    // accepted as an access token and could outlive its intended lifetime.
    if (claims.type !== ACCESS_TOKEN_TYPE) {
      throw new UnauthorizedException('Invalid or expired access token');
    }

    if (!claims.sub || !claims.org) {
      throw new UnauthorizedException('Invalid or expired access token');
    }

    request[REQUEST_ACTOR_KEY] = {
      userId: claims.sub,
      organizationId: claims.org,
      role: claims.role,
    };

    return true;
  }

  private extractBearerToken(header: string | undefined): string | null {
    if (!header || !header.startsWith(BEARER_PREFIX)) {
      return null;
    }
    const token = header.slice(BEARER_PREFIX.length).trim();
    return token === '' ? null : token;
  }
}
