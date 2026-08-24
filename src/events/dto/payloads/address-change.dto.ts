import { IsDateString, IsNotEmpty, IsString } from 'class-validator';

/**
 * Payload for ADDRESS_CHANGE events.
 */
export class AddressChangePayloadDto {
  @IsString({ message: 'employeeId must be a string' })
  @IsNotEmpty({ message: 'employeeId is required' })
  employeeId!: string;

  @IsDateString({}, { message: 'effectiveDate must be an ISO-8601 date string' })
  effectiveDate!: string;

  @IsString({ message: 'street must be a string' })
  @IsNotEmpty({ message: 'street is required' })
  street!: string;

  @IsString({ message: 'city must be a string' })
  @IsNotEmpty({ message: 'city is required' })
  city!: string;

  @IsString({ message: 'postalCode must be a string' })
  @IsNotEmpty({ message: 'postalCode is required' })
  postalCode!: string;

  @IsString({ message: 'country must be a string' })
  @IsNotEmpty({ message: 'country is required' })
  country!: string;
}