import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { CreateEventDto } from './dto/create-event.dto';
import { EventsService } from './events.service';

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