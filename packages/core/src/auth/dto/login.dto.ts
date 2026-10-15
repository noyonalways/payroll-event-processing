import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({
    description: 'Account email.',
    example: 'owner@acme.example',
  })
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(254)
  email!: string;

  @ApiProperty({
    description: 'Account password.',
    example: 'correct-horse-battery',
  })
  @IsString()
  @MinLength(1, { message: 'password must not be empty' })
  @MaxLength(128)
  password!: string;

  /**
   * Only needed when the account belongs to more than one organization. A
   * single-membership account can omit it; an ambiguous login is rejected with a
   * 400 that names the field rather than guessing a tenant.
   */
  @ApiProperty({
    description:
      'Organization to sign in to. Required only when the account belongs to more than one.',
    example: '6f1c1f5e-2a4b-4c8d-9e7f-0a1b2c3d4e5f',
    required: false,
  })
  @IsOptional()
  @IsUUID('4', { message: 'organizationId must be a UUID' })
  organizationId?: string;
}
