import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MinLength,
  ValidateIf,
} from 'class-validator';

/**
 * Body of PUT /provider-config (real-provider-adapter, OWNER-gated):
 * create-or-replace the organization's external payroll provider
 * configuration. Credential-bearing plaintext targets are rejected unless
 * loopback (local test receivers), mirroring the webhook URL rule.
 */
export class UpsertProviderConfigDto {
  @ApiProperty({
    example: 'HTTP',
    enum: ['SIMULATED', 'HTTP'],
    description:
      'SIMULATED resolves the default in-process provider; HTTP resolves the adapter against baseUrl with the credential.',
  })
  @IsIn(['SIMULATED', 'HTTP'], { message: 'mode must be SIMULATED or HTTP' })
  mode!: 'SIMULATED' | 'HTTP';

  @ApiPropertyOptional({
    example: 'https://payroll.acme.example/api/effects',
    description: 'External endpoint (required for HTTP mode).',
  })
  @ValidateIf((o) => o.mode === 'HTTP')
  @IsString({ message: 'baseUrl must be a string' })
  @IsNotEmpty({ message: 'baseUrl is required for HTTP mode' })
  baseUrl?: string;

  @ApiPropertyOptional({
    example: 'sk_live_9f2c...',
    minLength: 6,
    description:
      'Credential sent as the Authorization bearer on every external call. Required for HTTP mode; ' +
      'returned in full ONLY by this write response — reads redact it.',
  })
  @ValidateIf((o) => o.mode === 'HTTP')
  @IsString({ message: 'credential must be a string' })
  @MinLength(6, { message: 'credential must be at least 6 characters' })
  credential?: string;
}
