import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  Res,
} from '@nestjs/common';
import {
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Response } from 'express';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import { CreateEventDto } from './dto/create-event.dto';
import { EVENT_EXAMPLES } from './dto/event-examples';
import { EventSubmissionResponseDto } from './dto/event-submission-response.dto';
import { EventsService } from './events.service';

@ApiTags('events')
@Controller('events')
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  /**
   * POST /events — validate (per-type payload), dedupe by Idempotency-Key,
   * persist, and return the stored 201 response. The HTTP response is fast —
   * no background work happens here (that lands with the queue, change 3).
   */
  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: 'Submit a payroll event',
    description:
      'Validates the payload per eventType, dedupes by Idempotency-Key, persists ' +
      'the event, and returns the stored 201 response.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'Client-generated key uniquely identifying this submission. Re-submitting ' +
      'with the same key returns the stored response instead of creating a duplicate event.',
    example: 'b2f7e3d8-9a1c-4e5f-8c2b-1a0d9e8f7c6b',
  })
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
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, unknown>> {
    if (!idempotencyKey || idempotencyKey.trim() === '') {
      throw new BadRequestException('Idempotency-Key header is required');
    }

    const result = await this.eventsService.createEvent({
      eventType: dto.eventType,
      payload: dto.payload,
      idempotencyKey: idempotencyKey.trim(),
    });

    // Return the stored response exactly (same status + body on duplicates).
    res.status(result.httpStatus);
    return result.body;
  }
}