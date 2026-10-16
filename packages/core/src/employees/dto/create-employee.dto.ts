import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

/**
 * Body of POST /employees (employee-directory): register one employee in the
 * caller's organization. `employeeNumber` is matched exactly (case-sensitive)
 * and is the arbiter of the 409 conflict — the `(organization_id,
 * employee_number)` unique constraint is the store's truth, not this code.
 * Surrounding whitespace is trimmed by the service before anything is stored
 * or validated as blank.
 */
export class CreateEmployeeDto {
  @ApiProperty({
    example: 'emp-001',
    description:
      'Tenant-local employee number. Unique within the organization; immutable after creation.',
  })
  @IsString({ message: 'employeeNumber must be a string' })
  @IsNotEmpty({ message: 'employeeNumber is required' })
  employeeNumber!: string;

  @ApiProperty({
    example: 'Ada Lovelace',
    description: 'Display name.',
  })
  @IsString({ message: 'name must be a string' })
  @IsNotEmpty({ message: 'name is required' })
  name!: string;

  @ApiPropertyOptional({
    example: 'Engineering',
    description: 'Optional department grouping.',
  })
  @IsOptional()
  @IsString({ message: 'department must be a string' })
  department?: string;
}
