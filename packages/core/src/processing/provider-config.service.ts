import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ProviderMode } from '@prisma/client';
import { PrismaService } from '@repo/database';
import { UpsertProviderConfigDto } from './dto/provider-config.dto';
import {
  ProviderConfigCreatedDto,
  ProviderConfigResponseDto,
} from './dto/provider-config-response.dto';

/** Hosts where a plain-http external target is tolerated (local receivers). */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * OWNER-gated provider configuration storage (real-provider-adapter design
 * D3). One row per organization (the unique FK). Validation enforces the
 * contract: HTTP mode requires base URL + credential and an https (or
 * loopback-http, local receivers) target; the credential is stored
 * recoverable — the resolver needs it to authorize every call — but leaves
 * this service exactly once, in the write response (never in a read, never in
 * a log line).
 */
@Injectable()
export class ProviderConfigService {
  private readonly logger = new Logger(ProviderConfigService.name);

  constructor(private readonly prisma: PrismaService) {}

  async upsert(
    organizationId: string,
    dto: UpsertProviderConfigDto,
  ): Promise<ProviderConfigCreatedDto> {
    if (dto.mode === 'HTTP') {
      this.assertHttpTarget(dto.baseUrl as string);
    }

    const data = {
      mode: dto.mode as ProviderMode,
      baseUrl: dto.mode === 'HTTP' ? (dto.baseUrl as string) : null,
      // SIMULATED mode clears the secret entirely — no credential at rest
      // for a configuration that Authorizes nothing.
      credential: dto.mode === 'HTTP' ? (dto.credential as string) : null,
    };

    const row = await this.prisma.providerConfig.upsert({
      where: { organizationId },
      create: { organizationId, ...data },
      update: data,
    });

    this.logger.log(
      `Provider configuration saved for organization ${organizationId}: mode=${row.mode}`,
    );
    const response: ProviderConfigCreatedDto = {
      mode: row.mode as 'SIMULATED' | 'HTTP',
      baseUrl: row.baseUrl,
      credential: row.credential ?? '',
    };
    return response;
  }

  async read(organizationId: string): Promise<ProviderConfigResponseDto> {
    const row = await this.prisma.providerConfig.findUnique({
      where: { organizationId },
    });
    if (!row) {
      throw new NotFoundException('No provider configuration — the simulated provider is active');
    }
    return { mode: row.mode as 'SIMULATED' | 'HTTP', baseUrl: row.baseUrl };
  }

  async remove(organizationId: string): Promise<void> {
    const row = await this.prisma.providerConfig.findUnique({
      where: { organizationId },
      select: { id: true },
    });
    if (!row) {
      throw new NotFoundException('No provider configuration to delete');
    }
    await this.prisma.providerConfig.delete({ where: { organizationId } });
    this.logger.log(`Provider configuration deleted for organization ${organizationId}`);
  }

  private assertHttpTarget(baseUrl: string): void {
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new BadRequestException('baseUrl must be a valid URL');
    }
    if (parsed.protocol === 'https:') {
      return;
    }
    if (parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname)) {
      return;
    }
    throw new BadRequestException(
      'baseUrl must be an HTTPS URL (loopback http:// allowed for local receivers)',
    );
  }
}
