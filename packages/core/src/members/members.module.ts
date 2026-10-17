import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';

/**
 * Organization membership lifecycle (org-membership-management). `AuthModule`
 * is imported (not global) for `PasswordService` — acceptance verifies/sets
 * digests through the SAME scrypt policy registration uses, so a password
 * set via an invitation is indistinguishable from a registered one.
 *
 * Role gates come from the access-control decorators (`@Roles(ADMIN|OWNER)`)
 * registered globally by role-enforcement; the member list stays on the
 * any-member default.
 */
@Module({
  imports: [AuthModule],
  controllers: [MembersController],
  providers: [MembersService],
  exports: [MembersService],
})
export class MembersModule {}
