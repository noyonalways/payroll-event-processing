import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBadRequestResponse,
  ApiBody,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Response } from 'express';
import { EventType } from '@repo/shared';
import { AuthenticatedActor } from '../auth/authenticated-actor';
import { CurrentActor } from '../auth/decorators/current-actor.decorator';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import { IdempotencyKey } from '../common/idempotency/idempotency-key.decorator';
import { IDEMPOTENCY_HEADER } from '@repo/shared';
import { CreateEventDto } from './dto/create-event.dto';
import {
  EVENT_LIFECYCLE_STATUSES,
} from './dto/event-lifecycle';
import { EVENT_EXAMPLES } from './dto/event-examples';
import { EventSubmissionResponseDto } from './dto/event-submission-response.dto';
import { EventStatusResponseDto } from './dto/event-status-response.dto';
import { EventListResponseDto, EventsListQueryDto } from './dto/events-list.dto';
import { EventsService } from './events.service';

/**
 * Payroll event endpoints. All routes are tenant-scoped: the organization comes
 * from the verified access token via `@CurrentActor()`, never from the request.
 * No route carries `@Public()`, so the global guard requires a token — there
 * is no way to reach another organization's payroll data.
 */
@ApiTags('events')
@ApiBearerAuth()
@Controller('events')
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  /**
   * POST /events — validate (per-type payload), dedupe by Idempotency-Key via the
   * shared idempotency layer, persist, and return the stored 201 response. The
   * HTTP response is fast — no background work happens here (that lands with the
   * queue, change 3).
   *
   * The event is created inside the caller's organization; `Idempotency-Key` is
   * deduplicated within that organization only.
   */
  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: 'Submit a payroll event',
    description:
      'Validates the payload per eventType, dedupes by Idempotency-Key within the ' +
      'caller’s organization, persists the event, and returns the stored 201 response.',
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
  @ApiUnauthorizedResponse({
    description: 'Missing, invalid, or expired access token',
    type: ErrorResponseDto,
  })
  async create(
    @Body() dto: CreateEventDto,
    @IdempotencyKey() idempotencyKey: string,
    @CurrentActor() actor: AuthenticatedActor,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, unknown>> {
    const result = await this.eventsService.createEvent(actor.organizationId, {
      eventType: dto.eventType,
      payload: dto.payload,
      idempotencyKey,
    });

    // Return the stored response exactly (same status + body on duplicates).
    res.status(result.httpStatus);
    return result.body;
  }

  /**
   * GET /events — read-only, paginated event history (events-query-api), scoped
   * to the caller's organization. Keyset pagination on (created_at, id): passing
   * the previous page's `nextCursor` continues strictly after that position, so
   * pages never shift while new events arrive. Filters combine with AND and
   * compose with the cursor. Strictly read-only — no enqueue, no mutation.
   */
  @Get()
  @ApiOperation({
    summary: 'List the organization’s payroll events',
    description:
      'Read-only: one page of the caller’s organization’s event history, newest ' +
      'first (created_at DESC, id DESC), with combinable filters (status, ' +
      'eventType, employeeId, createdAfter/createdBefore) that AND together and ' +
      'compose with keyset pagination. Pass the previous page’s nextCursor as ' +
      'cursor to continue the walk; rows carry no payload, result, or attempts. ' +
      'No Idempotency-Key required.',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: EVENT_LIFECYCLE_STATUSES,
    description: 'Filter by lifecycle status.',
  })
  @ApiQuery({
    name: 'eventType',
    required: false,
    enum: EventType,
    description: 'Filter by event type.',
  })
  @ApiQuery({
    name: 'employeeId',
    required: false,
    type: String,
    description:
      'Filter by the submitted employee id, matched within the caller’s organization.',
  })
  @ApiQuery({
    name: 'createdAfter',
    required: false,
    type: String,
    description: 'Inclusive ISO-8601 lower bound on the event creation time.',
  })
  @ApiQuery({
    name: 'createdBefore',
    required: false,
    type: String,
    description: 'Inclusive ISO-8601 upper bound on the event creation time.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    minimum: 1,
    maximum: 100,
    default: 20,
    description: 'Page size (1–100). Defaults to 20 when omitted.',
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    type: String,
    description:
      'Opaque pagination token from a previous page’s nextCursor. An unparsable ' +
      'value is rejected with 400, not treated as absent.',
  })
  @ApiOkResponse({
    description: 'One page of the organization’s events, newest first',
    type: EventListResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'Invalid filter values, page size, or malformed cursor',
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing, invalid, or expired access token',
    type: ErrorResponseDto,
  })
  async list(
    @Query() query: EventsListQueryDto,
    @CurrentActor() actor: AuthenticatedActor,
  ): Promise<EventListResponseDto> {
    return this.eventsService.listEvents(actor.organizationId, query);
  }
  /**
   * GET /events/:id — read-only event status (event-status-api), scoped to the
   * caller's organization. Returns the event's current committed lifecycle state,
   * its details, and the terminal attempt history. An event owned by another
   * organization reads as 404 — the same response as an unknown id — so the
   * endpoint cannot be used to probe which ids exist elsewhere. No
   * Idempotency-Key required; pure read.
   */
  @Get(':id')
  @ApiOperation({
    summary: 'Get a payroll event status',
    description:
      'Read-only: returns the event lifecycle state, its details, and the terminal ' +
      'attempt history, within the caller’s organization. 404 when no such event ' +
      'belongs to it. No Idempotency-Key required.',
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
    description: 'No event with this id belongs to the caller’s organization',
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing, invalid, or expired access token',
    type: ErrorResponseDto,
  })
  async getStatus(
    @Param('id') id: string,
    @CurrentActor() actor: AuthenticatedActor,
  ): Promise<EventStatusResponseDto> {
    return this.eventsService.getEventStatus(actor.organizationId, id);
  }
}