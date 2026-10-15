import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import { AuthService } from './auth.service';
import { AuthenticatedActor } from './authenticated-actor';
import { CurrentActor } from './decorators/current-actor.decorator';
import { Public } from './decorators/public.decorator';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RegisterDto } from './dto/register.dto';
import { ActorIdentityDto, SessionResponseDto } from './dto/session-response.dto';

/**
 * Authentication and tenant membership. Only `GET /auth/me` requires an access
 * token; the rest are `@Public()` because they are how a caller obtains one — each
 * is authorized by the credential in its own body.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * POST /auth/register — creates a new organization with the caller as its OWNER
   * and returns a session for it. Registration always creates a tenant: there is no
   * self-service way into an existing organization.
   */
  @Public()
  @Post('register')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Register a new organization and its owner',
    description:
      'Creates the organization, the user account, and an OWNER membership, then ' +
      'returns an access/refresh token pair scoped to that organization.',
  })
  @ApiBody({ type: RegisterDto })
  @ApiCreatedResponse({ description: 'Organization and owner created', type: SessionResponseDto })
  @ApiConflictResponse({
    description: 'An account with this email already exists',
    type: ErrorResponseDto,
  })
  @ApiBadRequestResponse({ description: 'Validation error', type: ErrorResponseDto })
  async register(@Body() dto: RegisterDto): Promise<SessionResponseDto> {
    return this.authService.register(dto);
  }

  /**
   * POST /auth/login — exchanges credentials for a session bound to one
   * organization.
   */
  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Sign in',
    description:
      'Returns an access/refresh token pair for the organization the account ' +
      'belongs to. Accounts in several organizations must name one via ' +
      'organizationId. Invalid credentials and unknown emails both return 401.',
  })
  @ApiBody({ type: LoginDto })
  @ApiOkResponse({ description: 'Signed in', type: SessionResponseDto })
  @ApiUnauthorizedResponse({
    description: 'Invalid email or password',
    type: ErrorResponseDto,
  })
  async login(@Body() dto: LoginDto): Promise<SessionResponseDto> {
    return this.authService.login(dto);
  }

  /**
   * POST /auth/refresh — rotates a refresh token into a new session. The presented
   * token is consumed; replaying it revokes the whole token family.
   */
  @Public()
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Rotate a refresh token',
    description:
      'Consumes the presented refresh token and returns a new pair. The membership ' +
      'is re-checked, so a revoked membership cannot be refreshed.',
  })
  @ApiBody({ type: RefreshTokenDto })
  @ApiOkResponse({ description: 'Session rotated', type: SessionResponseDto })
  @ApiUnauthorizedResponse({
    description: 'Refresh token is unknown, expired, or already used',
    type: ErrorResponseDto,
  })
  async refresh(@Body() dto: RefreshTokenDto): Promise<SessionResponseDto> {
    return this.authService.refresh(dto.refreshToken);
  }

  /**
   * POST /auth/logout — revokes the presented refresh token. Idempotent, so a
   * client can always clear its session locally without handling an error.
   */
  @Public()
  @Post('logout')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Sign out',
    description: 'Revokes the presented refresh token. Always 204, even if the token was already invalid.',
  })
  @ApiBody({ type: RefreshTokenDto })
  @ApiNoContentResponse({ description: 'Refresh token revoked' })
  async logout(@Body() dto: RefreshTokenDto): Promise<void> {
    await this.authService.logout(dto.refreshToken);
  }

  /**
   * GET /auth/me — the caller's identity in the organization their access token
   * was minted for. Read-only and tenant-scoped.
   */
  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Current identity and organization',
    description:
      'Returns the authenticated user, the organization the access token is scoped ' +
      'to, and the role held there.',
  })
  @ApiOkResponse({ description: 'Current actor', type: ActorIdentityDto })
  @ApiUnauthorizedResponse({
    description: 'Missing, invalid, or expired access token',
    type: ErrorResponseDto,
  })
  async me(@CurrentActor() actor: AuthenticatedActor): Promise<ActorIdentityDto> {
    return this.authService.me(actor);
  }
}
