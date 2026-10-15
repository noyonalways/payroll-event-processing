import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { EventType } from './event-type';
import { PayloadDtoRegistry } from './dto/payload-registry';

/**
 * Validates the `payload` object of a submission against the DTO registered
 * for its `eventType`. Runs class-validator's `validate()` directly (the
 * global pipe cannot pick a payload type dynamically), with whitelist +
 * forbidNonWhitelisted so unknown payload fields are rejected (400).
 */
@Injectable()
export class PayloadValidator {
  private readonly logger = new Logger(PayloadValidator.name);

  async validate(eventType: EventType, payload: unknown): Promise<void> {
    const dtoClass = PayloadDtoRegistry[eventType];
    if (!dtoClass) {
      throw new BadRequestException(`Unsupported eventType: ${String(eventType)}`);
    }

    const instance = plainToInstance(dtoClass, payload);
    const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });

    if (errors.length > 0) {
      const messages = errors.flatMap((err) => {
        const constraints = Object.values(err.constraints ?? {});
        return constraints.length > 0
          ? constraints.map((message) => `${err.property}: ${message}`)
          : [`${err.property}: invalid value`];
      });
      this.logger.warn(`Payload validation failed for ${eventType}: ${messages.join('; ')}`);
      throw new BadRequestException(messages);
    }
  }
}