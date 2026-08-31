import { ApiExtraModels, ApiProperty, getSchemaPath } from '@nestjs/swagger';
import { IsEnum, IsObject } from 'class-validator';
import { EventType } from '../event-type';
import { AddressChangePayloadDto } from './payloads/address-change.dto';
import { BankAccountChangePayloadDto } from './payloads/bank-account-change.dto';
import { SalaryChangePayloadDto } from './payloads/salary-change.dto';
import { DepartmentChangePayloadDto } from './payloads/department-change.dto';

/**
 * Top-level submission body: `{ eventType, payload }`.
 *
 * The global ValidationPipe validates this DTO (whitelist + forbidNonWhitelisted,
 * transform). The `payload` object itself is validated per `eventType` by
 * PayloadValidator against the type-specific payload DTO.
 */
@ApiExtraModels(
  BankAccountChangePayloadDto,
  AddressChangePayloadDto,
  SalaryChangePayloadDto,
  DepartmentChangePayloadDto
)
export class CreateEventDto {
  @ApiProperty({
    enum: EventType,
    enumName: 'EventType',
    description: 'The payroll event type. Determines which payload schema applies.',
    example: EventType.BANK_ACCOUNT_CHANGE,
  })
  @IsEnum(EventType, { message: 'eventType must be one of the supported event types' })
  eventType!: EventType;

  @ApiProperty({
    description:
      'Event-type-specific payload. The required fields depend on eventType (see oneOf).',
    oneOf: [
      { $ref: getSchemaPath(BankAccountChangePayloadDto) },
      { $ref: getSchemaPath(AddressChangePayloadDto) },
      { $ref: getSchemaPath(SalaryChangePayloadDto) },
      { $ref: getSchemaPath(DepartmentChangePayloadDto) },
    ],
  })
  @IsObject({ message: 'payload must be an object' })
  payload!: Record<string, unknown>;
}