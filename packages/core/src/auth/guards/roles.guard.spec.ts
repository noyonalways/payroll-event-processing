import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MembershipRole } from '@prisma/client';
import { REQUEST_ACTOR_KEY, ROLES_KEY } from '../auth.constants';
import { AuthenticatedRequest } from '../authenticated-actor';
import { RolesGuard } from './roles.guard';

/**
 * Role-gate unit coverage (role-enforcement design D1/D2): at-or-above
 * hierarchy semantics, the no-metadata any-member default, and the fail-closed
 * malformed-actor path. The 401-before-403 ordering and the cross-tenant 404
 * asymmetry are covered end to end by `rbac.e2e-spec.ts` (guards compose in a
 * real app there); here the unit pins the DECISION TABLE.
 */
describe('RolesGuard', () => {
  const guard = new RolesGuard(new Reflector());
  const metadata = new Map<PropertyKey, unknown>();

  const contextFor = (
    role: MembershipRole | undefined,
    declared: MembershipRole[] | undefined,
  ): ExecutionContext => {
    const request = {
      [REQUEST_ACTOR_KEY]: role
        ? { userId: 'u-1', organizationId: 'org-1', role }
        : undefined,
    } as unknown as AuthenticatedRequest;

    metadata.clear();
    if (declared) {
      metadata.set(ROLES_KEY, declared);
    }
    const reflectorGet = jest
      .spyOn(Reflector.prototype, 'getAllAndOverride')
      .mockImplementation((key: PropertyKey) => metadata.get(key));

    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => 'handler',
      getClass: () => 'controller',
    } as unknown as ExecutionContext;

    // Keep the spy scoped per call — getAllAndOverride is global on the class.
    return Object.assign(context, { reflectorGet });
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('no metadata → any authenticated role passes (the documented default)', () => {
    for (const role of [MembershipRole.MEMBER, MembershipRole.ADMIN, MembershipRole.OWNER]) {
      expect(guard.canActivate(contextFor(role, undefined))).toBe(true);
    }
  });

  it('ADMIN-declared routes admit ADMIN and OWNER, deny MEMBER', () => {
    expect(guard.canActivate(contextFor(MembershipRole.ADMIN, [MembershipRole.ADMIN]))).toBe(true);
    expect(guard.canActivate(contextFor(MembershipRole.OWNER, [MembershipRole.ADMIN]))).toBe(true);
    expect(() =>
      guard.canActivate(contextFor(MembershipRole.MEMBER, [MembershipRole.ADMIN])),
    ).toThrow(ForbiddenException);
  });

  it('MEMBER-declared routes admit every role', () => {
    for (const role of [MembershipRole.MEMBER, MembershipRole.ADMIN, MembershipRole.OWNER]) {
      expect(guard.canActivate(contextFor(role, [MembershipRole.MEMBER]))).toBe(true);
    }
  });

  it('OWNER-only routes deny ADMIN and MEMBER', () => {
    expect(guard.canActivate(contextFor(MembershipRole.OWNER, [MembershipRole.OWNER]))).toBe(true);
    expect(() =>
      guard.canActivate(contextFor(MembershipRole.ADMIN, [MembershipRole.OWNER])),
    ).toThrow(ForbiddenException);
    expect(() =>
      guard.canActivate(contextFor(MembershipRole.MEMBER, [MembershipRole.OWNER])),
    ).toThrow(ForbiddenException);
  });

  it('a malformed actor rank (unknown role) is denied — fail closed', () => {
    expect(() =>
      guard.canActivate(
        contextFor('KNIGHT' as MembershipRole, [MembershipRole.MEMBER]),
      ),
    ).toThrow(ForbiddenException);
  });

  it('an almost-unknown declared role can never be satisfied', () => {
    expect(() =>
      guard.canActivate(contextFor(MembershipRole.OWNER, ['MONARCH' as MembershipRole])),
    ).toThrow(ForbiddenException);
  });
});
