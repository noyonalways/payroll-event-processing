import { ConfigService } from '@nestjs/config';
import { PermanentPayrollFailureError, TransientPayrollFailureError } from '@repo/shared';
import { HttpPayrollProvider } from './http-payroll-provider';
import { ProviderResolverService } from './provider-resolver.service';
import { SimulatedPayrollProvider } from './simulated-payroll-provider';

/**
 * HTTP adapter classification (real-provider-adapter design D4): the ENTIRE
 * matrix — 2xx+reference success; 2xx-without-reference / timeout / network /
 * 5xx transient; 4xx permanent with a sanitized reason; the credential NEVER
 * in an error; resolution precedence and re-read (no caching).
 */
describe('HttpPayrollProvider (classification matrix)', () => {
  const TARGET = { baseUrl: 'https://payroll.external.example/effects', credential: 'sk_secret_abc123' };

  const httpCall = jest.fn();

  const adapter = new HttpPayrollProvider(
    TARGET,
    { post: httpCall } as never,
    10_000,
  );

  const OPERATION = {
    organizationId: 'org-a',
    eventId: 'evt-1',
    eventType: 'SALARY_CHANGE',
    employeeId: 'emp-1',
    sequence: 3,
    payload: { newSalary: 50_000 },
    attempt: 2,
  };

  beforeEach(() => {
    httpCall.mockReset();
  });

  it('posts the documented contract with the bearer credential and exact body', async () => {
    httpCall.mockResolvedValueOnce({ status: 200, body: { reference: 'ext-1' }, error: null });

    await adapter.apply(OPERATION);

    const [url, headers, body, timeout] = httpCall.mock.calls[0];
    expect(url).toBe(TARGET.baseUrl);
    expect(headers.Authorization).toBe(`Bearer ${TARGET.credential}`);
    expect(timeout).toBe(10_000);
    expect(JSON.parse((body as Buffer).toString('utf8'))).toEqual({
      eventId: 'evt-1',
      organizationId: 'org-a',
      employeeId: 'emp-1',
      eventType: 'SALARY_CHANGE',
      sequence: 3,
      payload: { newSalary: 50_000 },
      attempt: 2,
    });
  });

  it('2xx + non-empty reference succeeds with that reference', async () => {
    httpCall.mockResolvedValueOnce({ status: 200, body: { reference: 'ext-123' }, error: null });
    await expect(adapter.apply(OPERATION)).resolves.toEqual({ reference: 'ext-123' });
  });

  it('2xx WITHOUT a reference is transient', async () => {
    httpCall.mockResolvedValueOnce({ status: 200, body: {}, error: null });
    await expect(adapter.apply(OPERATION)).rejects.toThrow(TransientPayrollFailureError);

    httpCall.mockResolvedValueOnce({ status: 200, body: null, error: null });
    await expect(adapter.apply(OPERATION)).rejects.toThrow(TransientPayrollFailureError);
  });

  it('a MALFORMED 2xx body is transient (server may answer right on retry)', async () => {
    httpCall.mockResolvedValueOnce({ status: 201, body: null, error: null });
    await expect(adapter.apply(OPERATION)).rejects.toThrow(TransientPayrollFailureError);
  });

  it('network errors and timeouts are transient', async () => {
    httpCall.mockResolvedValueOnce({ status: null, body: null, error: 'provider timeout after 10000ms' });
    await expect(adapter.apply(OPERATION)).rejects.toThrow(TransientPayrollFailureError);

    httpCall.mockResolvedValueOnce({ status: null, body: null, error: 'ECONNREFUSED' });
    await expect(adapter.apply(OPERATION)).rejects.toThrow(TransientPayrollFailureError);
  });

  it('5xx is transient', async () => {
    httpCall.mockResolvedValueOnce({ status: 503, body: { error: 'overloaded' }, error: null });
    await expect(adapter.apply(OPERATION)).rejects.toThrow(TransientPayrollFailureError);
  });

  it('4xx is PERMANENT carrying a bounded body excerpt', async () => {
    const bigBody: Record<string, unknown> = { message: 'x'.repeat(1000) };
    httpCall.mockResolvedValueOnce({ status: 422, body: bigBody, error: null });

    try {
      await adapter.apply(OPERATION);
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PermanentPayrollFailureError);
      const reason = (error as Error).message;
      expect(reason).toContain('provider rejected with 422');
      // Bounded: a 1000-char body cannot appear fully in the reason.
      expect(reason.length).toBeLessThan(500);
    }
  });

  it('the credential NEVER appears in any failure reason', async () => {
    const cases: Array<{ status: number | null; body: Record<string, unknown> | null; error: string | null }> = [
      { status: 404, body: { Authorization: TARGET.credential }, error: null },
      { status: null, body: null, error: `refused to ${TARGET.credential}` },
      { status: 500, body: null, error: null },
    ];
    for (const testCase of cases) {
      httpCall.mockResolvedValueOnce(testCase);
      try {
        await adapter.apply(OPERATION);
      } catch (error) {
        expect((error as Error).message).not.toContain('sk_secret_abc123');
      }
    }
  });
});

describe('ProviderResolverService (precedence + re-read)', () => {
  const makeHarness = () => {
    const prisma = { providerConfig: { findUnique: jest.fn() } };
    const simulated = new SimulatedPayrollProvider(
      // never invoked in these tests; config irrelevant
      undefined as never,
    );
    const config = { get: jest.fn(() => undefined) };
    const resolver = new ProviderResolverService(
      prisma as never,
      simulated as never,
      {} as never,
      config as unknown as ConfigService,
    );
    return { resolver, prisma, simulated };
  };

  it('no row / SIMULATED row → the simulated provider (per-invocation re-read)', async () => {
    const { resolver, prisma, simulated } = makeHarness();
    prisma.providerConfig.findUnique.mockResolvedValue(null);
    expect(await resolver.for('org-a')).toEqual({ kind: 'simulated', provider: simulated });

    prisma.providerConfig.findUnique.mockResolvedValue({ mode: 'SIMULATED' });
    expect(await resolver.for('org-a')).toEqual({ kind: 'simulated', provider: simulated });

    expect(prisma.providerConfig.findUnique).toHaveBeenCalledTimes(2);
  });

  it('an ACTIVE HTTP row → a fresh HttpPayrollProvider against the stored target', async () => {
    const { resolver, prisma } = makeHarness();
    prisma.providerConfig.findUnique.mockResolvedValue({
      mode: 'HTTP',
      baseUrl: 'https://ext.example/x',
      credential: 'cred-1',
    });

    const { kind, provider } = await resolver.for('org-a');
    expect(kind).toBe('http');
    expect(provider).toBeInstanceOf(HttpPayrollProvider);
    void provider;

    // A flaky row (HTTP without credential) falls back to simulated, loudly.
    prisma.providerConfig.findUnique.mockResolvedValue({ mode: 'HTTP', baseUrl: 'https://ext.example/x' });
    expect((await resolver.for('org-a')).kind).toBe('simulated');
  });
});
