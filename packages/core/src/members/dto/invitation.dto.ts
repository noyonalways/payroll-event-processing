import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsIn, IsNotEmpty, MaxLength } from 'class-validator';
import { MembershipRole } from '@prisma/client';

/**
 * Body of POST /invitations (org-membership-management): invite one email into
 * the caller's organization with an initial role. OWNER-role invitations are
 * rejected (`400`) — the last-owner invariant is never reachable through an
 * invitation. The email is normalized to lowercase by the service.
 */
export class CreateInvitationDto {
  @ApiProperty({
    example: 'ada@acme.example',
    description: 'The invited email address (lowercased on storage).',
  })
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(254, { message: 'email must be at most 254 characters' })
  email!: string;

  @ApiProperty({
    example: 'MEMBER',
    enum: ['ADMIN', 'MEMBER'],
    description: 'Initial role. OWNER is not invitable — roles already in the org are changed by the OWNER.',
  })
  @IsIn(['ADMIN', 'MEMBER'], { message: 'role must be ADMIN or MEMBER' })
  role!: Exclude<MembershipRole, 'OWNER'>;
}

/**
 * Body of PATCH /members/:userId/role (OWNER-gated). OWNER-role invitations do
 * not exist, so this is the only path that can mint a second OWNER.
 */
export class UpdateMemberRoleDto {
  @ApiProperty({
    example: 'MEMBER',
    enum: ['OWNER', 'ADMIN', 'MEMBER'],
    description: 'The new role for the membership. The last OWNER cannot be demoted.',
  })
  @IsNotEmpty({ message: 'role is required' })
  @IsIn(['OWNER', 'ADMIN', 'MEMBER'], { message: 'role must be OWNER, ADMIN, or MEMBER' })
  role!: MembershipRole;
}
