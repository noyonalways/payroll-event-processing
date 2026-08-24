import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsNotEmpty, IsString } from 'class-validator';

/**
 * Payload for ADDRESS_CHANGE events.
 */
export class AddressChangePayloadDto {
  @ApiProperty({ description: 'Employee identifier', example: 'emp-123' })
  @IsString({ message: 'employeeId must be a string' })
  @IsNotEmpty({ message: 'employeeId is required' })
  employeeId!: string;

  @ApiProperty({
    description: 'Effective date (ISO-8601)',
    example: '2026-09-01',
    format: 'date',
  })
  @IsDateString({}, { message: 'effectiveDate must be an ISO-8601 date string' })
  effectiveDate!: string;

  @ApiProperty({ description: 'Street and number', example: 'Main St' })
  @IsString({ message: 'street must be a string' })
  @IsNotEmpty({ message: 'street is required' })
  street!: string;

  @ApiProperty({ description: 'City', example: 'Berlin' })
  @IsString({ message: 'city must be a string' })
  @IsNotEmpty({ message: 'city is required' })
  city!: string;

  @ApiProperty({ description: 'Postal code', example: '10115' })
  @IsString({ message: 'postalCode must be a string' })
  @IsNotEmpty({ message: 'postalCode is required' })
  postalCode!: string;

  @ApiProperty({ description: 'ISO 3166-1 alpha-2 country code', example: 'DE' })
  @IsString({ message: 'country must be a string' })
  @IsNotEmpty({ message: 'country is required' })
  country!: string;
}