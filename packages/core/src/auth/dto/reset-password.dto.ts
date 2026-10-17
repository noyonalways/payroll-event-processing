import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

/** Body of POST /auth/forgot-password — always answered identically. */
export class ForgotPasswordDto {
  @ApiProperty({
    example: 'owner@acme.example',
    description: 'The (possibly unknown) account email — the response never reveals which.',
  })
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(254, { message: 'email must be at most 254 characters' })
  email!: string;
}

/**
 * Body of POST /auth/reset-password — the single-use token from the
 * forgot-password step plus the new password (strength policy identical to
 * registration). Every dead-token case is one opaque error.
 */
export class ResetPasswordDto {
  @ApiProperty({
    example: 'hR8xTq3nWbK1mZ0vP5cD7gJ2yF4sL9aQ',
    description: 'The single-use reset token (shown once by /auth/forgot-password).',
  })
  @IsString()
  @MinLength(10, { message: 'token is too short' })
  token!: string;

  @ApiProperty({
    example: 'correct-horse-battery',
    minLength: 12,
    description: 'The new password (same strength policy as registration).',
  })
  @IsString()
  @MinLength(12, { message: 'password must be at least 12 characters' })
  @MaxLength(128, { message: 'password must be at most 128 characters' })
  password!: string;
}

/**
 * The forgot-password acknowledgement. `token` is `null` in BOTH the
 * unknown-email case AND (per deployment choice) any non-handoff deployment —
 * the shape never reveals account existence. With hand-off (this deployment's
 * contract), an existing account gets the one-time token here.
 */
export class ResetRequestAcknowledgementDto {
  @ApiProperty({
    example: 'hR8xTq3nWbK1mZ0vP5cD7gJ2yF4sL9aQ',
    nullable: true,
    description:
      'The single-use reset token for out-of-band hand-off — present ONLY when the email has ' +
      'an account, and never for unknown emails (same response shape, so it leaks nothing).',
  })
  token!: string | null;
}
