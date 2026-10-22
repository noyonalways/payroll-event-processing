import { ThrottlerGuard, ThrottlerRequest } from '@nestjs/throttler';
import { THROTTLE_EXEMPT_PREFIXES } from './throttle.constants';

/**
 * The ThrottlerGuard variant that never throttles the liveness/scrape
 * surfaces (auth-hardening design D3): an orchestrator probe or a Prometheus
 * scrape at 15 s cadence would burn its limit and then break the very
 * monitoring that watches it. Every OTHER route keeps the profile limits.
 */
export class SkipThrottlerGuard extends ThrottlerGuard {
  protected async handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    const url =
      requestProps.context.switchToHttp().getRequest<{ originalUrl?: string; path?: string }>()
        .originalUrl ?? '';
    if (
      requestProps.context.getType() === 'http' &&
      THROTTLE_EXEMPT_PREFIXES.some((prefix) => url.startsWith(prefix))
    ) {
      return true;
    }

    // The 'strict' throttler profile (auth-hardening design D3) is intended ONLY
    // for credential/auth routes that explicitly declare @Throttle({ strict: ... }).
    // Undecorated routes must not inherit the strict 5-request limit.
    if (requestProps.throttler.name === 'strict') {
      const handler = requestProps.context.getHandler();
      const classRef = requestProps.context.getClass();
      const hasStrict = this.reflector.getAllAndOverride('THROTTLER:LIMITstrict', [
        handler,
        classRef,
      ]);
      if (hasStrict === undefined) {
        return true;
      }
    }

    return super.handleRequest(requestProps);
  }
}
