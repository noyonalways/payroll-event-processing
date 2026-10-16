import { Controller, Get, Req, Res } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AuthenticatedActor } from '../auth/authenticated-actor';
import { CurrentActor } from '../auth/decorators/current-actor.decorator';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import { EventStreamService } from './event-stream.service';

/**
 * GET /events/stream — the push-side twin of GET /events/{id} (realtime-status,
 * event-status-stream): one authenticated, tenant-scoped `text/event-stream`
 * per client, delivering a notification per committed lifecycle transition of
 * the caller's organization. Best-effort by contract — a client reconnecting
 * resynchronizes through the read endpoints; nothing is replayed.
 *
 * No `@Public()`: the global guard demands a token, exactly like every other
 * event endpoint, so an anonymous caller can neither listen nor confirm that
 * the stream exists.
 */
@ApiTags('events')
@ApiBearerAuth()
@Controller('events')
export class EventStreamController {
  constructor(private readonly eventStream: EventStreamService) {}

  @Get('stream')
  @ApiOperation({
    summary: 'Stream the organization’s payroll event lifecycle transitions',
    description:
      'Server-sent events: one JSON notification per committed lifecycle ' +
      'transition (submission, terminal success/failure, retry, cancel) of the ' +
      'caller’s organization, with heartbeat liveness comments. Best-effort ' +
      'delivery — reconnecting clients re-synchronize via GET /events and ' +
      'GET /events/{id}; no replay of past notifications.',
  })
  @ApiOkResponse({
    description:
      'An open text/event-stream connection. Frames: `event: lifecycle` with a ' +
      'JSON `data` payload (organizationId, eventId, eventType, employeeId, ' +
      'sequence, status, occurredAt) per transition, plus `: heartbeat` ' +
      'comment lines at a fixed interval.',
    schema: {
      type: 'string',
      example: ': heartbeat 2026-10-16T10:00:00.000Z\n\nevent: lifecycle\ndata: {"organizationId":"…","eventId":"…","eventType":"BANK_ACCOUNT_CHANGE","employeeId":"…","sequence":1,"status":"success","occurredAt":"…"}\n\n',
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Missing, invalid, or expired access token',
    type: ErrorResponseDto,
  })
  stream(
    @CurrentActor() actor: AuthenticatedActor,
    @Req() req: Request,
    @Res() res: Response,
  ): void {
    this.eventStream.openStream(actor.organizationId, req, res);
  }
}
