import { ApiProperty } from '@nestjs/swagger';
import { MembershipRole } from '@prisma/client';

export class SessionUserDto {
  @ApiProperty({ description: 'User id.', example: 'f3c6df52-9d13-4d7b-a2d1-9f8d4c2c8a9b' })
  id!: string;

  @ApiProperty({ description: 'Account email.', example: 'owner@acme.example' })
  email!: string;

  @ApiProperty({
    description: 'Display name, when set.',
    example: 'Ada Lovelace',
    nullable: true,
  })
  name!: string | null;
}

export class SessionOrganizationDto {
  @ApiProperty({ description: 'Organization id — the tenancy boundary.' })
  id!: string;

  @ApiProperty({ description: 'Organization display name.', example: 'Acme Payroll' })
  name!: string;

  @ApiProperty({ description: 'URL-safe unique handle.', example: 'acme-payroll' })
  slug!: string;
}

/** The caller's identity + tenant, without any credential material. */
export class ActorIdentityDto {
  @ApiProperty({ type: SessionUserDto })
  user!: SessionUserDto;

  @ApiProperty({ type: SessionOrganizationDto })
  organization!: SessionOrganizationDto;

  @ApiProperty({
    enum: MembershipRole,
    description: 'The caller’s role within this organization.',
    example: MembershipRole.OWNER,
  })
  role!: MembershipRole;
}

/**
 * Response of register / login / refresh. The only place a refresh token is ever
 * returned — it is not recoverable afterwards, only rotatable.
 */
export class SessionResponseDto extends ActorIdentityDto {
  @ApiProperty({
    description: 'Short-lived JWT to send as `Authorization: Bearer <token>`.',
  })
  accessToken!: string;

  @ApiProperty({
    description:
      'Opaque refresh token. Single-use: refreshing rotates it and revokes the presented value.',
  })
  refreshToken!: string;

  @ApiProperty({ description: 'Authorization scheme for the access token.', example: 'Bearer' })
  tokenType!: string;

  @ApiProperty({ description: 'Access-token lifetime as configured.', example: '15m' })
  expiresIn!: string;

  @ApiProperty({
    description: 'ISO-8601 expiry of the refresh token.',
    example: '2026-11-14T12:00:00.000Z',
  })
  refreshExpiresAt!: string;
}
