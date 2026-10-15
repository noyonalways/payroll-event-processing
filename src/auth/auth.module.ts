import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

/**
 * Authentication, identity, and the global tenancy guard.
 *
 * `JwtModule` is registered `global` so the guard (and any future verifier) can
 * inject `JwtService` without every feature module re-importing it. The signing
 * secret comes from `AUTH_JWT_SECRET`, which `ConfigModule`'s Joi schema makes
 * REQUIRED — a missing secret fails the boot rather than silently signing with
 * an empty key.
 *
 * The guard is bound with `APP_GUARD`, which applies it to every route in the
 * application. Protection is therefore the default state: a new endpoint is
 * authenticated unless it explicitly declares `@Public()`, so forgetting to add
 * a guard cannot expose tenant data.
 */
@Module({
  imports: [
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('AUTH_JWT_SECRET'),
        signOptions: { algorithm: 'HS256' },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    TokenService,
    PasswordService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
  exports: [AuthService, TokenService, PasswordService],
})
export class AuthModule {}
