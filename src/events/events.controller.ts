import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import {
  ApiBody,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Response } from 'express';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import { IdempotencyKey } from '../common/idempotency/idempotency-key.decorator';
import { IDEMPOTENCY_HEADER } from '../common/idempotency/idempotency.constants';
import { CreateEventDto } from './dto/create-event.dto';
import { EVENT_EXAMPLES } from './dto/event-examples';
import { EventSubmissionResponseDto } from './dto/event-submission-response.dto';
import { EventStatusResponseDto } from './dto/event-status-response.dto';
import { EventsService } from './events.service';

@ApiTags('events')
@Controller('events')
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  /**
   * POST /events — validate (per-type payload), dedupe by Idempotency-Key via the
   * shared idempotency layer, persist, and return the stored 201 response. The
   * HTTP response is fast — no background work happens here (that lands with the
   * queue, change 3).
   */
  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: 'Submit a payroll event',
    description:
      'Validates the payload per eventType, dedupes by Idempotency-Key, persists ' +
      'the event, and returns the stored 201 response.',
  })
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiBody({
    type: CreateEventDto,
    description: 'Typed payroll event submission.',
    examples: EVENT_EXAMPLES,
  })
  @ApiResponse({
    status: 201,
    description: 'Event accepted and persisted',
    type: EventSubmissionResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'Validation error: missing Idempotency-Key header, invalid payload, ' +
      'unsupported event type, or unknown fields',
    type: ErrorResponseDto,
  })
  async create(
    @Body() dto: CreateEventDto,
    @IdempotencyKey() idempotencyKey: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, unknown>> {
    const result = await this.eventsService.createEvent({
      eventType: dto.eventType,
      payload: dto.payload,
      idempotencyKey,
    });

    // Return the stored response exactly (same status + body on duplicates).
    res.status(result.httpStatus);
    return result.body;
  }

  /**
   * GET /events/:id — read-only event status (event-status-api). Returns the
   * event's current committed lifecycle state, its details, and the terminal
   * attempt history. Unknown id → 404 (shaped by the global filter into the
   * documented ErrorResponseDto). No Idempotency-Key required — pure read.
   */
  @Get(':id')
  @ApiOperation({
    summary: 'Get a payroll event status',
    description:
      'Read-only: returns the event lifecycle state, its details, and the terminal ' +
      'attempt history. 404 when no event matches the id. No Idempotency-Key required.',
  })
  @ApiParam({
    name: 'id',
    description: 'Event identifier (UUID)',
    example: 'f3c6df52-9d13-4d7b-a2d1-9f8d4c2c8a9b',
  })
  @ApiOkResponse({
    description: 'Event status retrieved',
    type: EventStatusResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'No event matches the id',
    type: ErrorResponseDto,
  })
  async getStatus(@Param('id') id: string): Promise<EventStatusResponseDto> {
    return this.eventsService.getEventStatus(id);
  }
}