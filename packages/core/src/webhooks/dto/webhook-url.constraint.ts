import { ValidatorConstraint, ValidatorConstraintInterface, ValidationArguments } from 'class-validator';

/**
 * Webhook callback URL rule (integrator-webhooks): HTTPS always; plain http is
 * accepted ONLY for explicit loopback hosts — the standard affordance that
 * lets local test receivers (and self-referential demo targets) work without
 * weakening the production posture for any public endpoint.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

@ValidatorConstraint({ name: 'webhookUrl', async: false })
export class WebhookUrlConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string') {
      return false;
    }
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return false;
    }
    if (parsed.protocol === 'https:') {
      return true;
    }
    return parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname);
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} must be a valid HTTPS URL (http:// allowed only for loopback hosts)`;
  }
}
