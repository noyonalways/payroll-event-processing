import { MembershipRole } from '@prisma/client';
import { Request } from 'express';
import { REQUEST_ACTOR_KEY } from './auth.constants';

/**
 * The authenticated caller's tenant identity, resolved by `JwtAuthGuard` from a
 * verified access token.
 *
 * `organizationId` is the tenancy boundary: every tenant-scoped read and write
 * takes it from here and puts it in the WHERE clause. Because the claims are
 * signed, a caller cannot change organizations by editing a request — only by
 * presenting a token minted for another organization.
 */
export interface AuthenticatedActor {
  userId: string;
  organizationId: string;
  role: MembershipRole;
}

/**
 * Shape of an access token's claims. Deliberately minimal — no email or name —
 * so a token that leaks into a log line carries no PII, and `GET /auth/me` reads
 * the profile from the database instead.
 */
export interface AccessTokenClaims {
  /** User id. */
  sub: string;
  /** Organization id — the tenancy boundary. */
  org: string;
  role: MembershipRole;
  /** Distinguishes an access token from a refresh token at verification time. */
  type: string;
}

/** Express request after `JwtAuthGuard` has run. */
export interface AuthenticatedRequest extends Request {
  [REQUEST_ACTOR_KEY]?: AuthenticatedActor;
}
