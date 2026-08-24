import { IsEnum, IsObject } from 'class-validator';
import { EventType } from '../event-type';

/**
 * Top-level submission body: `{ eventType, payload }`.
 *
 * The global ValidationPipe validates this DTO (whitelist + forbidNonWhitelisted,
 * transform). The `payload` object itself is validated per `eventType` by
 * PayloadValidator against the type-specific payload DTO.
 */
export class CreateEventDto {
  @IsEnum(EventType, { message: 'eventType must be one of the supported event types' })
  eventType!: EventType;

  @IsObject({ message: 'payload must be an object' })
  payload!: Record<string, unknown>;
}