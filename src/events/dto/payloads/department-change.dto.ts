import { ApiProperty } from '@nestjs/swagger';
import {
  IsDateString,
  IsNotEmpty,
  IsString,
  Length,
} from 'class-validator';

/**
 * Payload for DEPARTMENT_CHANGE events.
 */
export class DepartmentChangePayloadDto {
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

  @ApiProperty({
    description: 'New department the employee is transferred to',
    example: 'Engineering',
  })
  @IsString({ message: 'newDepartment must be a string' })
  @IsNotEmpty({ message: 'newDepartment is required' })
  @Length(1, 100, { message: 'newDepartment must be 1–100 characters' })
  newDepartment!: string;
}