import { SetMetadata } from '@nestjs/common';
import { IS_PUBLIC_KEY } from '../auth.constants';

/**
 * Marks a route (or controller) as reachable without an access token. The global
 * `JwtAuthGuard` denies by default, so every new endpoint is protected unless it
 * opts out explicitly here — the failure mode of forgetting is a 401, not a leak.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
