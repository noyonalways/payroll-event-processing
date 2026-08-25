import { BadRequestException, ExecutionContext } from '@nestjs/common';
import {
  IdempotencyKey,
  idempotencyKeyFactory,
} from './idempotency-key.decorator';

describe('@IdempotencyKey', () => {
  const ctxWith = (headers: Record<string, unknown>): ExecutionContext =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ headers }) }),
    }) as unknown as ExecutionContext;

  it('is a parameter decorator usable on a controller handler', () => {
    expect(typeof IdempotencyKey).toBe('function');
  });

  it('rejects a missing header', () => {
    expect(() => idempotencyKeyFactory(undefined, ctxWith({}))).toThrow(
      BadRequestException,
    );
  });

  it('rejects a header containing only whitespace', () => {
    expect(() =>
      idempotencyKeyFactory(undefined, ctxWith({ 'idempotency-key': '   ' })),
    ).toThrow(BadRequestException);
  });

  it('rejects a key over 128 characters', () => {
    expect(() =>
      idempotencyKeyFactory(
        undefined,
        ctxWith({ 'idempotency-key': 'x'.repeat(129) }),
      ),
    ).toThrow(BadRequestException);
  });

  it('rejects a key with non-printable characters', () => {
    expect(() =>
      idempotencyKeyFactory(
        undefined,
        ctxWith({ 'idempotency-key': 'bad\x00key' }),
      ),
    ).toThrow(BadRequestException);
  });

  it('accepts a 128-character printable key (at the limit)', () => {
    const key128 = 'x'.repeat(128);
    expect(
      idempotencyKeyFactory(undefined, ctxWith({ 'idempotency-key': key128 })),
    ).toBe(key128);
  });

  it('trims surrounding whitespace and returns the validated key', () => {
    expect(
      idempotencyKeyFactory(
        undefined,
        ctxWith({
          'idempotency-key': '  b2f7e3d8-9a1c-4e5f-8c2b-1a0d9e8f7c6b  ',
        }),
      ),
    ).toBe('b2f7e3d8-9a1c-4e5f-8c2b-1a0d9e8f7c6b');
  });
});