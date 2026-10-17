import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { AppModule, HttpExceptionFilter } from '@repo/core';
import { PrismaService } from '@repo/database';
import { EventStatus, MembershipRole } from '@prisma/client';
import { TestTenant, registerTenant, TEST_PASSWORD } from './support/auth';

/**
 * E2E for the RBAC gate (role-enforcement / access-control spec): the real
 * HTTP surface over the full guard chain — authentication (401) → role gate
 * (403) → tenant isolation (404, in services).
 *
 * ADMIN and MEMBER sessions inside ONE organization are minted by registering
 * material users (each registration makes the caller OWNER of a throwaway
 * tenant), binding extra `memberships` rows for the owner's organization, and
 * logging in through the real `POST /auth/login` with an explicit
 * `organizationId` — exactly the path a second member will take after
 * org-membership-management lands.
 *
 * Baseline matrix verified: submission and all reads stay open to every
 * member; retry/cancel and employee mutations require ADMIN or higher;
 * unauthenticated calls keep 401 (never 403); an elevated caller probing a
 * foreign organization's event keeps the tenant-driven 404; a MEMBER probing
 * the same id through a gated operation gets the operation denial (403) —
 * role denial is resource-independent and never leaks existence (design D3).
 */
describe('RBAC enforcement (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let owner: TestTenant;
  let admin: TestTenant;
  let member: TestTenant;
  let otherOrg: TestTenant;
  let employeeId: string;

  beforeAll(async () => {
    // API-only boot: nothing drains the queue, so events stay where the
    // recovery-role tests need them (row mutations are direct where needed).
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();

    prisma = app.get(PrismaService);
    owner = await registerTenant(app, 'rbac-owner');
    otherOrg = await registerTenant(app, 'rbac-other');

    // Materialize two more users, then bind them into the owner's organization
    // with the roles under test. (Their own demo organizations exist but are
    // irrelevant here; the unique membership key never collides.)
    const adminMaterial = await registerTenant(app, 'rbac-admin-material');
    const memberMaterial = await registerTenant(app, 'rbac-member-material');
    for (const [user, role] of [
      [adminMaterial, MembershipRole.ADMIN],
      [memberMaterial, MembershipRole.MEMBER],
    ] as const) {
      await prisma.membership.create({
        data: {
          userId: user.userId,
          organizationId: owner.organizationId,
          role,
        },
      });
    }
    admin = await loginInto(owner.organizationId, adminMaterial.email);
    member = await loginInto(owner.organizationId, memberMaterial.email);

    const employeeRow = await prisma.employee.findFirstOrThrow({
      where: { organizationId: owner.organizationId, active: true },
      select: { employeeNumber: true, id: true },
    });
    employeeId = employeeRow.employeeNumber;
  });

  afterAll(async () => {
    await app.close();
  });

  /** Real login into a specific organization (role comes from the membership). */
  const loginInto = async (organizationId: string, email: string): Promise<TestTenant> => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: TEST_PASSWORD, organizationId });
    expect(res.status).toBe(200);
    const base: TestTenant = {
      organizationId,
      organizationSlug: res.body.organization?.slug ?? '',
      organizationName: res.body.organization?.name ?? '',
      userId: res.body.user?.id ?? '',
      email,
      password: TEST_PASSWORD,
      accessToken: res.body.accessToken,
      refreshToken: res.body.refreshToken,
      headers: { Authorization: `Bearer ${res.body.accessToken}` },
    };
    return base;
  };

  const submitEvent = (as: TestTenant, amount = 9000) =>
    request(app.getHttpServer())
      .post('/events')
      .set(as.headers)
      .set('Idempotency-Key', `rbac-${randomUUID()}`)
      .send({
        eventType: 'SALARY_CHANGE',
        payload: {
          employeeId,
          effectiveDate: '2026-10-01',
          newSalary: amount,
          currency: 'EUR',
        },
      });

  const retry = (id: string, as: TestTenant) =>
    request(app.getHttpServer()).post(`/events/${id}/retry`).set(as.headers);

  const cancel = (id: string, as: TestTenant) =>
    request(app.getHttpServer()).post(`/events/${id}/cancel`).set(as.headers);

  const createEmployee = (as: TestTenant, body: object) =>
    request(app.getHttpServer()).post('/employees').set(as.headers).send(body);

  const patchEmployee = (as: TestTenant, id: string, body: object) =>
    request(app.getHttpServer()).patch(`/employees/${id}`).set(as.headers).send(body);

  const deleteEmployee = (as: TestTenant, id: string) =>
    request(app.getHttpServer()).delete(`/employees/${id}`).set(as.headers);

  /** One queued event, submitted by the tenant under test. */
  const queuedEvent = async (as: TestTenant) => {
    const res = await submitEvent(as, Math.floor(Math.random() * 100000));
    expect(res.status).toBe(201);
    return res.body as { id: string };
  };

  describe('reads and submission stay open to every member', () => {
    it('a member submits events, reads history, the directory, and an event detail', async () => {
      expect((await submitEvent(member)).status).toBe(201);
      expect((await request(app.getHttpServer()).get('/events').set(member.headers)).status).toBe(200);
      expect(
        (await request(app.getHttpServer()).get('/employees').set(member.headers)).status,
      ).toBe(200);

      const submit = await submitEvent(member);
      const listRes = await request(app.getHttpServer()).get('/events').set(member.headers);
      const listed = listRes.body.data.find(
        (e: { id: string }) => e.id === submit.body.id,
      );
      expect(listed).toBeTruthy();
      const detail = await request(app.getHttpServer())
        .get(`/events/${submit.body.id}`)
        .set(member.headers);
      expect(detail.status).toBe(200);
    });
  });

  describe('recovery actions require ADMIN or higher', () => {
    it('a member receives 403 on retry and cancel; rows untouched', async () => {
      const failed = await queuedEvent(member);
      await prisma.payrollEvent.update({
        where: { id: failed.id },
        data: { status: EventStatus.FAILED },
      });

      const retryRes = await retry(failed.id, member);
      expect(retryRes.status).toBe(403);
      expect(retryRes.body.error).toBe('ForbiddenException');

      const pending = await queuedEvent(member);
      const cancelRes = await cancel(pending.id, member);
      expect(cancelRes.status).toBe(403);

      expect(
        (await prisma.payrollEvent.findFirstOrThrow({ where: { id: failed.id } })).status,
      ).toBe(EventStatus.FAILED);
      expect(
        (await prisma.payrollEvent.findFirstOrThrow({ where: { id: pending.id } })).status,
      ).toBe(EventStatus.QUEUED);
      // A failed event is not consumed by the rejected retry — it stays retryable.
      expect(await retry(failed.id, member).then((r) => r.status)).toBe(403);
    });

    it('an admin retries a failed event (operation executes as usual)', async () => {
      const failed = await queuedEvent(member);
      await prisma.payrollEvent.update({
        where: { id: failed.id },
        data: { status: EventStatus.FAILED },
      });

      const res = await retry(failed.id, admin);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('queued');
    });

    it('an admin cancels a queued event', async () => {
      const pending = await queuedEvent(member);
      expect((await cancel(pending.id, admin)).status).toBe(200);
      expect(
        (await prisma.payrollEvent.findFirstOrThrow({ where: { id: pending.id } })).status,
      ).toBe(EventStatus.CANCELLED);
    });

    it('an owner passes the admin gate too (at-or-above semantics over HTTP)', async () => {
      const failed = await queuedEvent(owner);
      await prisma.payrollEvent.update({
        where: { id: failed.id },
        data: { status: EventStatus.FAILED },
      });
      expect((await retry(failed.id, owner)).status).toBe(200);
    });
  });

  describe('employee mutations require ADMIN or higher', () => {
    it('a member receives 403 on create, patch, and archive — no record changes', async () => {
      const before = await prisma.employee.count({
        where: { organizationId: owner.organizationId },
      });

      const created = await createEmployee(member, {
        employeeNumber: `rbac-${randomUUID().slice(0, 8)}`,
        name: 'Blocked Member',
      });
      expect(created.status).toBe(403);

      const target = await prisma.employee.findFirstOrThrow({
        where: { organizationId: owner.organizationId, active: true },
        select: { id: true },
      });
      expect((await patchEmployee(member, target.id, { name: 'Hacked' })).status).toBe(403);
      expect((await deleteEmployee(member, target.id)).status).toBe(403);

      const after = await prisma.employee.count({
        where: { organizationId: owner.organizationId },
      });
      expect(after).toBe(before);
      expect(
        (await prisma.employee.findFirstOrThrow({ where: { id: target.id } })).name,
      ).not.toBe('Hacked');
    });

    it('an admin and the owner create, correct, and archive employees', async () => {
      const number = `rbac-admin-${randomUUID().slice(0, 8)}`;
      const created = await createEmployee(admin, { employeeNumber: number, name: 'Admin Made' });
      expect(created.status).toBe(201);

      const patched = await patchEmployee(admin, created.body.id, { department: 'Ops' });
      expect(patched.status).toBe(200);
      expect(patched.body.department).toBe('Ops');

      expect((await deleteEmployee(owner, created.body.id)).status).toBe(204);
    });
  });

  describe('guard ordering: authentication → role → tenancy', () => {
    it('no token keeps 401 before any role evaluation', async () => {
      const failed = await queuedEvent(member);
      await prisma.payrollEvent.update({
        where: { id: failed.id },
        data: { status: EventStatus.FAILED },
      });
      const res = await request(app.getHttpServer()).post(`/events/${failed.id}/retry`);
      expect(res.status).toBe(401);
    });

    it('a member probing a foreign id gets the operation denial (403), not a 404', async () => {
      const foreign = await queuedEvent(otherOrg);
      const res = await retry(foreign.id, member);
      expect(res.status).toBe(403);
    });

    it('an elevated caller probing a foreign id keeps the tenant-driven 404', async () => {
      const foreign = await queuedEvent(otherOrg);
      await prisma.payrollEvent.update({
        where: { id: foreign.id },
        data: { status: EventStatus.FAILED },
      });
      const res = await retry(foreign.id, owner);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('NotFoundException');
    });
  });
});
