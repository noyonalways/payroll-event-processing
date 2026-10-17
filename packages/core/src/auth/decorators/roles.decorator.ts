import { SetMetadata } from '@nestjs/common';
import { ApiExtension } from '@nestjs/swagger';
import { MembershipRole } from '@prisma/client';
import { ROLES_KEY } from '../auth.constants';

/**
 * Declares the MINIMUM membership role a route requires
 * (role-enforcement design D2). The guard grants the caller when their token's
 * role is the declared role OR ANY HIGHER one — `@Roles(ADMIN)` means
 * "ADMIN or OWNER". A route with no declaration stays open to every
 * authenticated actor (reads, submission, session routes).
 *
 * ALWAYS pair with the Swagger marker so the API docs surface the requirement.
 */
export const Roles = (...roles: MembershipRole[]) => SetMetadata(ROLES_KEY, roles);

/**
 * Stamps the declared minimum role into the OpenAPI document as the
 * `x-required-role` extension, so `/api-docs` renders the authorization
 * posture alongside the usual 401/403 response references (design D4).
 */
export const ApiRoles = (...roles: MembershipRole[]) =>
  ApiExtension('x-required-role', roles);
