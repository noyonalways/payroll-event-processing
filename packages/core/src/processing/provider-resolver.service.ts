import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@repo/database';
import {
  ExternalPayrollProviderResolver,
  ProviderKind,
} from './external-payroll-provider';
import { HttpPayrollProvider } from './http-payroll-provider';
import { ProviderHttpClient } from './provider-http.client';
import { SimulatedPayrollProvider } from './simulated-payroll-provider';

/**
 * Per-organization provider resolution (real-provider-adapter design D1): the
 * org's `provider_configs` row is RE-READ for every operation — an ACTIVE
 * HTTP configuration resolves the adapter, anything else (no row, SIMULATED
 * mode) resolves the simulated provider. No caching: configuration changes
 * take effect on the next operation without a restart (spec scenario).
 *
 * The provider itself NEVER delays or breaks the critical path's correctness:
 * resolution is one indexed SELECT on the unique FK, and a malformed row
 * (HTTP mode without URL/credential) falls back to the simulated provider
 * with a loud log line rather than failing the event.
 */
@Injectable()
export class ProviderResolverService implements ExternalPayrollProviderResolver {
  private readonly logger = new Logger(ProviderResolverService.name);
  private readonly timeoutMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly simulated: SimulatedPayrollProvider,
    private readonly httpClient: ProviderHttpClient,
    config: ConfigService,
  ) {
    this.timeoutMs = config.get<number>('PROVIDER_HTTP_TIMEOUT_MS') ?? 10_000;
  }

  async for(
    organizationId: string,
  ): Promise<{ kind: ProviderKind; provider: import('./external-payroll-provider').ExternalPayrollProvider }> {
    const config = await this.prisma.providerConfig.findUnique({
      where: { organizationId },
    });

    if (
      config?.mode === 'HTTP' &&
      config.baseUrl &&
      config.credential
    ) {
      this.logger.debug(
        `Provider resolved for organization ${organizationId}: http (${config.baseUrl})`,
      );
      return {
        kind: 'http',
        provider: new HttpPayrollProvider(
          { baseUrl: config.baseUrl, credential: config.credential },
          this.httpClient,
          this.timeoutMs,
        ),
      };
    }

    if (config?.mode === 'HTTP') {
      this.logger.warn(
        `Provider configuration for organization ${organizationId} is HTTP without ` +
          `${config.baseUrl ? 'a credential' : 'a base URL'} — falling back to the simulated provider`,
      );
    }

    this.logger.debug(
      `Provider resolved for organization ${organizationId}: simulated`,
    );
    return { kind: 'simulated', provider: this.simulated };
  }
}
