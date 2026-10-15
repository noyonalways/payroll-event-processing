import { getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PayrollEventQueueService, perEmployeeJobId } from './payroll-event-queue.service';
import { PAYROLL_EVENTS_QUEUE, PAYROLL_EVENT_JOB, EventType } from '@repo/shared';
const ORG = 'org-a';
const OTHER_ORG = 'org-b';

describe('PayrollEventQueueService', () => {
  let service: PayrollEventQueueService;

  const queue = {
    add: jest.fn(),
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  };

  /** Helper to build the service with a specific retry config. */
  async function buildService(
    maxRetryAttempts = 5,
    retryBaseDelayMs = 1000,
  ): Promise<PayrollEventQueueService> {
    const configMock = {
      get: jest.fn((key: string, defaultValue?: unknown) => {
        if (key === 'PAYROLL_MAX_RETRY_ATTEMPTS') return maxRetryAttempts;
        if (key === 'PAYROLL_RETRY_BASE_DELAY_MS') return retryBaseDelayMs;
        return defaultValue;
      }),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PayrollEventQueueService,
        { provide: getQueueToken(PAYROLL_EVENTS_QUEUE), useValue: queue },
        { provide: ConfigService, useValue: configMock },
      ],
    }).compile();

    return moduleRef.get<PayrollEventQueueService>(PayrollEventQueueService);
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    service = await buildService();
  });

  describe('enqueue (per-employee FIFO producer)', () => {
    it('adds the job keyed by organization+employee with retry + FIFO/retention options', async () => {
      queue.add.mockResolvedValue({ id: 'org-a|emp-1' });

      await service.enqueue({
        eventId: 'evt-1',
        organizationId: ORG,
        eventType: EventType.BANK_ACCOUNT_CHANGE,
        employeeId: 'emp-1',
        sequence: 3,
      });

      expect(queue.add).toHaveBeenCalledWith(
        PAYROLL_EVENT_JOB,
        expect.objectContaining({
          eventId: 'evt-1',
          organizationId: ORG,
          eventType: EventType.BANK_ACCOUNT_CHANGE,
          employeeId: 'emp-1',
          sequence: 3, // JSON-safe — the caller converts bigint → Number
        }),
        {
          // jobId is tenant-qualified: BullMQ short-circuits an add
          // whose jobId exists, so at most one job per employee WITHIN one
          // organization is in flight (design D2/D8).
          jobId: 'org-a|emp-1',
          // Retry policy (R1): exponential backoff up to the configured cap.
          attempts: 5,
          backoff: { type: 'exponential', delay: 1000 },
          // Completed/failed jobs are freed so the SAME jobId can be re-added by
          // the worker's relay — a retained completed job would suppress it and
          // starve the FIFO (design D5).
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
    });

    it('carries the organization in the job data so the worker can scope its claim', async () => {
      queue.add.mockResolvedValue({ id: 'org-a|emp-1' });

      await service.enqueue({
        eventId: 'evt-1',
        organizationId: ORG,
        eventType: EventType.BANK_ACCOUNT_CHANGE,
        employeeId: 'emp-1',
        sequence: 1,
      });

      const data = queue.add.mock.calls[0][1] as Record<string, unknown>;
      expect(data.organizationId).toBe(ORG);
    });

    it('gives the same employee id in two organizations its own job slot', async () => {
      queue.add.mockResolvedValue({ id: 'x' });

      await service.enqueue({
        eventId: 'evt-a',
        organizationId: ORG,
        eventType: EventType.BANK_ACCOUNT_CHANGE,
        employeeId: 'emp-1',
        sequence: 1,
      });
      await service.enqueue({
        eventId: 'evt-b',
        organizationId: OTHER_ORG,
        eventType: EventType.BANK_ACCOUNT_CHANGE,
        employeeId: 'emp-1',
        sequence: 1,
      });

      // Distinct job ids: one organization's in-flight job must not suppress the
      // other's, or a tenant's backlog would delay an unrelated tenant.
      const jobIds = queue.add.mock.calls.map((call) => (call[2] as { jobId: string }).jobId);
      expect(jobIds).toEqual(['org-a|emp-1', 'org-b|emp-1']);
      expect(new Set(jobIds).size).toBe(2);
    });

    it('uses custom retry config when overridden via environment', async () => {
      const customService = await buildService(3, 500);
      queue.add.mockResolvedValue({ id: 'org-a|emp-custom' });

      await customService.enqueue({
        eventId: 'evt-custom',
        organizationId: ORG,
        eventType: EventType.ADDRESS_CHANGE,
        employeeId: 'emp-custom',
        sequence: 1,
      });

      expect(queue.add).toHaveBeenCalledWith(
        PAYROLL_EVENT_JOB,
        expect.any(Object),
        expect.objectContaining({
          attempts: 3,
          backoff: { type: 'exponential', delay: 500 },
        }),
      );
    });

    it('a suppressed duplicate (existing jobId) resolves as a silent no-op', async () => {
      // addStandardJob short-circuits when the jobId key already exists
      // (wait/active) and returns the existing job — no throw, no second job.
      queue.add.mockResolvedValue({ id: 'org-a|emp-1' });

      await expect(
        service.enqueue({
          eventId: 'evt-dup',
          organizationId: ORG,
          eventType: EventType.ADDRESS_CHANGE,
          employeeId: 'emp-1',
          sequence: 2,
        }),
      ).resolves.toBeUndefined();

      expect(queue.add).toHaveBeenCalledTimes(1);
    });

    it('converts bigint sequences to JSON-safe numbers', async () => {
      queue.add.mockResolvedValue({ id: 'org-a|emp-2' });

      await service.enqueue({
        eventId: 'evt-2',
        organizationId: ORG,
        eventType: EventType.SALARY_CHANGE,
        employeeId: 'emp-2',
        sequence: 1,
      });

      const data = queue.add.mock.calls[0][1] as Record<string, unknown>;
      expect(data.sequence).toBe(1);
      expect(typeof data.sequence).toBe('number');
    });
  });

  describe('perEmployeeJobId', () => {
    it('is tenant-qualified and injective across organizations', () => {
      expect(perEmployeeJobId(ORG, 'emp-1')).toBe('org-a|emp-1');
      expect(perEmployeeJobId(OTHER_ORG, 'emp-1')).not.toBe(perEmployeeJobId(ORG, 'emp-1'));
    });

    it('never contains a colon — BullMQ rejects a custom id with one', () => {
      // BullMQ throws `Custom Id cannot contain :` unless the id splits into
      // exactly three segments, so a colon separator would make every `add` throw
      // — and the producer swallows that error by design, leaving events stuck.
      for (const [org, employee] of [
        [ORG, 'emp-1'],
        ['org-with:colon', 'emp:2'],
        [OTHER_ORG, 'weird|employee|id'],
      ]) {
        expect(perEmployeeJobId(org, employee)).not.toContain(':');
      }
    });

    it('stays injective when an identifier contains the separator', () => {
      // Distinct (organization, employee) pairs must never collapse onto one job
      // id — a collision would silently suppress a submission's job.
      const pairs: Array<[string, string]> = [
        [ORG, 'emp|1'],
        [ORG, 'emp'],
        [`${ORG}|emp`, '1'],
        [ORG, '1'],
      ];
      const ids = pairs.map(([org, employee]) => perEmployeeJobId(org, employee));
      expect(new Set(ids).size).toBe(pairs.length);
    });
  });

  describe('lifecycle', () => {
    it('subscribes to Redis connection errors so they never go unhandled', () => {
      expect(queue.on).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('closes the queue on module destroy', async () => {
      await service.onModuleDestroy();
      expect(queue.close).toHaveBeenCalledTimes(1);
    });
  });
});
