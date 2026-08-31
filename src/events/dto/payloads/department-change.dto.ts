import { ApiProperty } from "@nestjs/swagger";
import { IsDateString, IsNotEmpty, IsString } from "class-validator";


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
    description: 'New department name',
    example: 'Engineering',
  })
  @IsString({ message: 'newDepartment must be a string' })
  @IsNotEmpty({ message: 'newDepartment is required' })
  newDepartment!: string;
}