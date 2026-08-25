import { BadRequestException, createParamDecorator } from '@nestjs/common';
import { Request } from 'express';
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_PRINTABLE_ASCII,
} from './idempotency.constants';

/**
 * Reads the `Idempotency-Key` request header, validates it (required, trimmed,
 * non-blank, printable ASCII, at most 128 characters), and exposes the trimmed
 * key to the handler. Violations throw BadRequestException, which the global
 * HttpExceptionFilter shapes into the structured 400 body — no operation runs.
 */
export const idempotencyKeyFactory = (
  _data: unknown,
  ctx: import('@nestjs/common').ExecutionContext,
): string => {
  const request = ctx.switchToHttp().getRequest<Request>();
  const header = request.headers['idempotency-key'];

  if (header === undefined) {
    throw new BadRequestException('Idempotency-Key header is required');
  }

  const raw = Array.isArray(header) ? String(header[0]) : String(header);
  const key = raw.trim();

  if (key === '') {
    throw new BadRequestException('Idempotency-Key header must not be blank');
  }
  if (key.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw new BadRequestException(
      `Idempotency-Key header must be at most ${IDEMPOTENCY_KEY_MAX_LENGTH} characters`,
    );
  }
  if (!IDEMPOTENCY_KEY_PRINTABLE_ASCII.test(key)) {
    throw new BadRequestException(
      'Idempotency-Key header must contain only printable ASCII characters',
    );
  }

  return key;
};

/**
 * Parameter decorator: `@IdempotencyKey() key: string` in a controller handler.
 */
export const IdempotencyKey = createParamDecorator(idempotencyKeyFactory);