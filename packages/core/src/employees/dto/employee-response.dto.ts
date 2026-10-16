import { ApiProperty } from '@nestjs/swagger';

/**
 * One directory employee (employee-directory): the representation returned by
 * every employees endpoint. `employeeNumber` is the tenant-local public
 * identifier a payload references as `employeeId`; `name` is `null` only for
 * rows adopted from pre-directory event history.
 */
export class EmployeeResponseDto {
  @ApiProperty({
    example: 'f3c6df52-9d13-4d7b-a2d1-9f8d4c2c8a9b',
    description: 'Unique employee record identifier (UUID)',
  })
  id!: string;

  @ApiProperty({
    example: 'emp-001',
    description:
      'Tenant-local employee number — the same identifier event payloads carry as `employeeId`. ' +
      'Unique within the organization, including archived rows; immutable after creation.',
  })
  employeeNumber!: string;

  @ApiProperty({
    example: 'Ada Lovelace',
    nullable: true,
    description: 'Display name. Null only for rows adopted from event history whose name is unknown.',
  })
  name!: string | null;

  @ApiProperty({
    example: 'Engineering',
    nullable: true,
    description: 'Optional department grouping.',
  })
  department!: string | null;

  @ApiProperty({
    example: true,
    description:
      'Whether the employee is active. Archived (active=false) employees keep ' +
      'their record and reserved number but no longer accept events.',
  })
  active!: boolean;

  @ApiProperty({
    example: '2026-10-16T09:00:00.000Z',
    description: 'ISO-8601 creation timestamp',
  })
  createdAt!: string;

  @ApiProperty({
    example: '2026-10-16T09:00:00.000Z',
    description: 'ISO-8601 last-update timestamp',
  })
  updatedAt!: string;
}
