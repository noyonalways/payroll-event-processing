import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { EventsListQueryDto } from './events-list.dto';

/**
 * Validation contract of the GET /events query parameters (events-query-api),
 * exercised through a ValidationPipe configured EXACTLY like the production one
 * in apps/api/src/main.ts (whitelist + forbidNonWhitelisted + transform with
 * implicit conversion) so the DTO and the pipe are tested as the pair that
 * actually runs.
 */
describe('EventsListQueryDto', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  });

  const validate = (query: Record<string, unknown>) =>
    pipe.transform(query, { type: 'query', metatype: EventsListQueryDto });

  const messagesOf = (error: BadRequestException): string[] => {
    const response = error.getResponse() as { message: string | string[] };
    return Array.isArray(response.message) ? response.message : [response.message];
  };

  describe('valid combinations', () => {
    it('accepts an empty query (page one, defaults apply)', async () => {
      const dto = await validate({});
      expect(dto.status).toBeUndefined();
      expect(dto.limit).toBeUndefined();
      expect(dto.cursor).toBeUndefined();
    });

    it('accepts every filter combined with pagination', async () => {
      const dto = await validate({
        status: 'failed',
        eventType: 'SALARY_CHANGE',
        employeeId: 'emp-1',
        createdAfter: '2026-08-01T00:00:00.000Z',
        createdBefore: '2026-08-31T23:59:59.999Z',
        limit: '50',
        cursor: 'an-opaque-token',
      });

      // Implicit conversion turned the raw query-string limit into a number.
      expect(dto).toEqual({
        status: 'failed',
        eventType: 'SALARY_CHANGE',
        employeeId: 'emp-1',
        createdAfter: '2026-08-01T00:00:00.000Z',
        createdBefore: '2026-08-31T23:59:59.999Z',
        limit: 50,
        cursor: 'an-opaque-token',
      });
    });

    it('accepts each boundary limit value (1 and 100)', async () => {
      await expect(validate({ limit: '1' })).resolves.toMatchObject({ limit: 1 });
      await expect(validate({ limit: '100' })).resolves.toMatchObject({ limit: 100 });
    });

    it('accepts a single filter alone (status)', async () => {
      await expect(validate({ status: 'queued' })).resolves.toMatchObject({
        status: 'queued',
      });
    });
  });

  describe('invalid values rejected with an identifying message', () => {
    it('rejects an unknown status', async () => {
      const error = await validate({ status: 'archived' }).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(BadRequestException);
      expect(messagesOf(error as BadRequestException).join(' ')).toContain('status');
    });

    it('rejects an unknown event type', async () => {
      const error = await validate({ eventType: 'PROMOTION' }).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(BadRequestException);
      expect(messagesOf(error as BadRequestException).join(' ')).toContain(
        'eventType',
      );
    });

    it('rejects a malformed createdAfter date', async () => {
      const error = await validate({ createdAfter: 'not-a-date' }).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(BadRequestException);
      expect(messagesOf(error as BadRequestException).join(' ')).toContain(
        'createdAfter',
      );
    });

    it('rejects a malformed createdBefore date', async () => {
      const error = await validate({ createdBefore: '31/12/2026' }).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(BadRequestException);
      expect(messagesOf(error as BadRequestException).join(' ')).toContain(
        'createdBefore',
      );
    });

    it('rejects a limit of 0 and a limit above the maximum (101)', async () => {
      const zero = await validate({ limit: '0' }).catch((e: unknown) => e);
      expect(zero).toBeInstanceOf(BadRequestException);
      expect(messagesOf(zero as BadRequestException).join(' ')).toContain('limit');

      const over = await validate({ limit: '101' }).catch((e: unknown) => e);
      expect(over).toBeInstanceOf(BadRequestException);
      expect(messagesOf(over as BadRequestException).join(' ')).toContain('limit');
    });

    it('rejects a non-numeric limit', async () => {
      const error = await validate({ limit: 'all' }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect(messagesOf(error as BadRequestException).join(' ')).toContain('limit');
    });
  });

  describe('deny-by-default parameter surface', () => {
    it('rejects an undeclared query parameter instead of ignoring it', async () => {
      // whitelist + forbidNonWhitelisted makes undeclared-but-sent parameters a
      // structured 400 — the desired over-sharing failure mode (design D4).
      const error = await validate({ payload: 'evt-1' }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect(messagesOf(error as BadRequestException).join(' ')).toContain(
        'payload',
      );
    });

    it('rejects a mistyped known parameter name (e.g. status typo)', async () => {
      const error = await validate({ eventStatus: 'failed' }).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(BadRequestException);
      expect(messagesOf(error as BadRequestException).join(' ')).toContain(
        'eventStatus',
      );
    });
  });
});
