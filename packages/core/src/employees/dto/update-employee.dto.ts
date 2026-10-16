import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';

/**
 * Body of PATCH /employees/:id (employee-directory): partial corrections to
 * `name`, `department`, and the `active` flag. `employeeNumber` is DELIBERATELY
 * not a property: the global ValidationPipe (forbidNonWhitelisted) rejects any
 * attempt to change it with a structured 400 — the number is the stable
 * cross-reference between events and the directory.
 */
export class UpdateEmployeeDto {
  @ApiPropertyOptional({
    example: 'Ada King',
    description: 'Replacement display name.',
  })
  @IsOptional()
  @IsString({ message: 'name must be a string' })
  @IsNotEmpty({ message: 'name must not be blank' })
  name?: string;

  @ApiPropertyOptional({
    example: 'People',
    description: 'Replacement department.',
  })
  @IsOptional()
  @IsString({ message: 'department must be a string' })
  department?: string;

  @ApiPropertyOptional({
    example: false,
    description: 'Archive (false) or reactivate (true) the employee.',
  })
  @IsOptional()
  @IsBoolean({ message: 'active must be a boolean' })
  active?: boolean;
}
