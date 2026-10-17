import { ApiProperty } from '@nestjs/swagger';

/**
 * One organization member (org-membership-management): the row the member
 * list returns. `email` is the account identity — readable inside the
 * organization by design (the directory of WHO is in), not a tenant secret.
 */
export class MemberResponseDto {
  @ApiProperty({
    example: 'u-1f8a…',
    description: 'User id (the membership’s target user).',
  })
  userId!: string;

  @ApiProperty({
    example: 'ada@acme.example',
    description: 'Account email (lowercased).',
  })
  email!: string;

  @ApiProperty({
    example: 'Ada Lovelace',
    nullable: true,
    description: 'Display name, when set.',
  })
  name!: string | null;

  @ApiProperty({
    example: 'ADMIN',
    description: 'The membership role: OWNER, ADMIN, or MEMBER.',
  })
  role!: string;

  @ApiProperty({
    example: '2026-10-16T09:00:00.000Z',
    description: 'When the membership was created (joined at).',
  })
  joinedAt!: string;
}

/**
 * One outstanding invitation as the management list returns it. The accept
 * TOKEN is never here — it exists only in the create response.
 */
export class InvitationResponseDto {
  @ApiProperty({
    example: 'inv-7c2b…',
    description: 'Unique invitation record identifier (UUID).',
  })
  id!: string;

  @ApiProperty({
    example: 'ada@acme.example',
    description: 'The invited (lowercased) email.',
  })
  email!: string;

  @ApiProperty({
    example: 'MEMBER',
    description: 'The role the membership will carry at acceptance.',
  })
  role!: string;

  @ApiProperty({
    example: 'PENDING',
    description: 'PENDING, ACCEPTED, or REVOKED.',
  })
  status!: string;

  @ApiProperty({
    example: 'u-owner-1',
    description: 'The inviting user’s id.',
  })
  invitedBy!: string;

  @ApiProperty({
    example: '2026-10-23T09:00:00.000Z',
    description: 'After this instant the token is no longer acceptable.',
  })
  expiresAt!: string;

  @ApiProperty({
    example: '2026-10-16T09:00:00.000Z',
    nullable: true,
    description: 'Set when the invitation was accepted.',
  })
  acceptedAt!: string | null;

  @ApiProperty({
    example: '2026-10-16T09:00:00.000Z',
    description: 'ISO-8601 creation timestamp.',
  })
  createdAt!: string;
}

/**
 * The POST /invitations response: the invitation record PLUS the one-time
 * accept token/URL — the only place the raw token ever appears.
 */
export class InvitationCreatedDto extends InvitationResponseDto {
  @ApiProperty({
    example: 'hR8xTq3nWbK1mZ0vP5cD7gJ2yF4sL9aQ',
    description:
      'The single-use accept token. Shown ONLY here; share it out-of-band. ' +
      'The accept endpoint is `POST /invitations/accept`.',
  })
  acceptToken!: string;

  @ApiProperty({
    example: 'https://app.example.com/invite/hR8xTq3n…',
    description: 'Convenience accept URL carrying the token (for hand-off).',
  })
  acceptUrl!: string;
}
