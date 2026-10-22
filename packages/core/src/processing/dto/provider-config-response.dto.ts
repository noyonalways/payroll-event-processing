import { ApiProperty } from '@nestjs/swagger';

/**
 * The provider configuration representation (real-provider-adapter). The
 * credential is NEVER here — reads redact it; the write response that set it
 * returns it in full exactly once (mirroring webhook secrets).
 */
export class ProviderConfigResponseDto {
  @ApiProperty({
    example: 'HTTP',
    description: 'SIMULATED (default in-process provider) or HTTP (external adapter).',
  })
  mode!: 'SIMULATED' | 'HTTP';

  @ApiProperty({
    example: 'https://payroll.acme.example/api/effects',
    nullable: true,
    description: 'The external endpoint. Null for SIMULATED mode.',
  })
  baseUrl!: string | null;
}

/** The PUT response: the representation PLUS the one-time credential. */
export class ProviderConfigCreatedDto extends ProviderConfigResponseDto {
  @ApiProperty({
    example: 'sk_live_9f2c...',
    description:
      'The credential exactly as submitted. Returned ONLY here; every later read redacts it.',
  })
  credential!: string;
}
