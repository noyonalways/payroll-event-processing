import { ApiProperty } from '@nestjs/swagger';
import { MinLength, MaxLength } from 'class-validator';
import { IsString } from 'class-validator';

/**
 * Body of POST /invitations/accept (PUBLIC — the route is gated by possession
 * of the single-use invitation token, org-membership-management design D3).
 * The password serves double duty with the same strength policy as
 * registration: it SETS the initial password when the invited email has no
 * account, and PROVES account ownership when it already exists. Both cases use
 * the one body — the service distinguishes by looking up the invited email.
 */
export class AcceptInvitationDto {
  @ApiProperty({
    example: 'hR8xTq3nWbK1mZ0vP5cD7gJ2yF4sL9aQ',
    description: 'The one-time accept token from the invitation (returned at creation).',
  })
  @IsString()
  token!: string;

  @ApiProperty({
    example: 'correct-horse-battery',
    minLength: 12,
    maxLength: 128,
    description:
      'Existing-account password (proves ownership) or the initial password for a new account ' +
      '(same strength policy as registration).',
  })
  @IsString()
  @MinLength(12, { message: 'password must be at least 12 characters' })
  @MaxLength(128, { message: 'password must be at most 128 characters' })
  password!: string;
}

/**
 * The acceptance result: enough for the invitee (or the inviting UI) to log
 * into the organization they just joined — the session itself still comes
 * from the normal login flow.
 */
export class AcceptInvitationResultDto {
  @ApiProperty({
    example: '9f1d3c66-4b5e-4b1f-9d18-7b2e6a0c1f66',
    description: 'The organization the membership was created in.',
  })
  organizationId!: string;

  @ApiProperty({
    example: 'Acme Payroll',
    description: 'The organization name at acceptance time.',
  })
  organizationName!: string;

  @ApiProperty({
    example: 'MEMBER',
    description: 'The role granted with the membership.',
  })
  role!: string;

  @ApiProperty({
    example: 'ada@acme.example',
    description: 'The invited email (the account identity to log in with).',
  })
  email!: string;
}
