import { Module } from '@nestjs/common';
import { ProviderConfigController } from './provider-config.controller';
import { ProviderConfigService } from './provider-config.service';

/**
 * The provider-configuration HTTP surface (real-provider-adapter design D3),
 * its own module because it belongs to the API app: ProcessingModule (the
 * resolver's home) is deliberately worker-side, and the OWNER must manage the
 * provider from the API. PrismaModule is global, as everywhere in core.
 */
@Module({
  controllers: [ProviderConfigController],
  providers: [ProviderConfigService],
  exports: [ProviderConfigService],
})
export class ProviderConfigModule {}
