import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Registration creates a NEW tenant: the caller becomes the OWNER of the
 * organization they name. Joining an existing organization is not a public
 * operation — that needs an invitation issued by an existing member, which is a
 * later change (there is no self-service way into someone else's tenant here).
 */
export class RegisterDto {
  @ApiProperty({
    description: 'Account email. Stored lowercased; unique across the platform.',
    example: 'owner@acme.example',
  })
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(254)
  email!: string;

  @ApiProperty({
    description: 'Account password (minimum 12 characters).',
    example: 'correct-horse-battery',
    minLength: 12,
  })
  @IsString()
  @MinLength(12, { message: 'password must be at least 12 characters' })
  @MaxLength(128, { message: 'password must be at most 128 characters' })
  password!: string;

  @ApiProperty({
    description: 'Display name of the registering user.',
    example: 'Ada Lovelace',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiProperty({
    description: 'Name of the organization (tenant) to create.',
    example: 'Acme Payroll',
  })
  @IsString()
  @MinLength(1, { message: 'organizationName must not be empty' })
  @MaxLength(120)
  organizationName!: string;
}
