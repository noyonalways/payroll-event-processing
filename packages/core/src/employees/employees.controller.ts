import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiConflictResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthenticatedActor } from '../auth/authenticated-actor';
import { ApiRoles, Roles } from '../auth/decorators/roles.decorator';
import { MembershipRole } from '@prisma/client';
import { CurrentActor } from '../auth/decorators/current-actor.decorator';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';
import { EmployeeResponseDto } from './dto/employee-response.dto';
import { EmployeesListQueryDto, EmployeesListResponseDto } from './dto/employees-list.dto';
import { EmployeesService } from './employees.service';

/**
 * Payroll employee directory endpoints (employee-directory). All routes are
 * tenant-scoped: the organization comes from the verified access token via
 * `@CurrentActor()`, never from the request. No route carries `@Public()`, so
 * the global guard requires a token — another organization's record is
 * indistinguishable from an unknown one (404).
 */
@ApiTags('employees')
@ApiBearerAuth()
@Controller('employees')
export class EmployeesController {
  constructor(private readonly employeesService: EmployeesService) {}

  /**
   * POST /employees — register one employee in the caller's organization.
   * The per-organization unique employee number is the arbiter of the 409:
   * a duplicate (including an archived row's reserved number) is rejected by
   * the store, never guessed at here (design D4).
   */
  @ApiForbiddenResponse({ description: 'Requires the ADMIN role or higher', type: ErrorResponseDto })
  @Roles(MembershipRole.ADMIN)
  @ApiRoles(MembershipRole.ADMIN)
  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: 'Register an employee in the caller’s organization',
    description:
      'Creates an active directory record with a tenant-local employeeNumber. ' +
      'Duplicate numbers inside the organization — including archived ones — are ' +
      'rejected with 409.',
  })
  @ApiResponse({
    status: 201,
    description: 'Employee registered',
    type: EmployeeResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'Validation error: missing or blank fields, or unknown fields',
    type: ErrorResponseDto,
  })
  @ApiConflictResponse({
    description: 'An employee with this employeeNumber already exists in this organization',
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing, invalid, or expired access token',
    type: ErrorResponseDto,
  })
  async create(
    @Body() dto: CreateEmployeeDto,
    @CurrentActor() actor: AuthenticatedActor,
  ): Promise<EmployeeResponseDto> {
    return this.employeesService.create(actor.organizationId, dto);
  }

  /**
   * GET /employees — read-only, keyset-paginated directory page ordered by
   * employee number ascending, with combinable `active` and `search` filters
   * that AND together and compose with the cursor (design D6). Strictly
   * read-only — no enqueue, no mutation.
   */
  @Get()
  @ApiOperation({
    summary: 'List the organization’s employees',
    description:
      'Read-only: one page of the caller’s organization’s directory, ordered by ' +
      'employee number ascending, with combinable filters (active, search) that ' +
      'AND together and compose with keyset pagination. Pass the previous page’s ' +
      'nextCursor as cursor to continue the walk. No Idempotency-Key required.',
  })
  @ApiOkResponse({
    description: 'One page of the organization’s directory, ordered by employee number',
    type: EmployeesListResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'Invalid filter values, page size, or malformed cursor',
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing, invalid, or expired access token',
    type: ErrorResponseDto,
  })
  async list(
    @Query() query: EmployeesListQueryDto,
    @CurrentActor() actor: AuthenticatedActor,
  ): Promise<EmployeesListResponseDto> {
    return this.employeesService.list(actor.organizationId, query);
  }

  /**
   * GET /employees/:id — read-only single record. Another organization's
   * employee reads as 404 — the same response as an unknown id — so the
   * endpoint cannot probe which ids exist elsewhere.
   */
  @Get(':id')
  @ApiOperation({
    summary: 'Get an employee record',
    description:
      'Read-only: the full record of one employee within the caller’s organization. ' +
      '404 when no such record belongs to it. No Idempotency-Key required.',
  })
  @ApiParam({
    name: 'id',
    description: 'Employee record identifier (UUID)',
    example: 'f3c6df52-9d13-4d7b-a2d1-9f8d4c2c8a9b',
  })
  @ApiOkResponse({
    description: 'Employee record retrieved',
    type: EmployeeResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'No employee with this id belongs to the caller’s organization',
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing, invalid, or expired access token',
    type: ErrorResponseDto,
  })
  async get(
    @Param('id') id: string,
    @CurrentActor() actor: AuthenticatedActor,
  ): Promise<EmployeeResponseDto> {
    return this.employeesService.get(actor.organizationId, id);
  }

  /**
   * PATCH /employees/:id — partial corrections (`name`, `department`,
   * `active`). `employeeNumber` is not a declared property, so an attempt to
   * change it is rejected with a structured 400 by the global pipe — the
   * number is the immutable cross-reference between events and the directory.
   */
  @ApiForbiddenResponse({ description: 'Requires the ADMIN role or higher', type: ErrorResponseDto })
  @Roles(MembershipRole.ADMIN)
  @ApiRoles(MembershipRole.ADMIN)
  @Patch(':id')
  @ApiOperation({
    summary: 'Correct an employee’s details',
    description:
      'Updates name, department, and/or the active flag within the caller’s ' +
      'organization. The employeeNumber is immutable: a body carrying it is ' +
      'rejected with 400.',
  })
  @ApiParam({
    name: 'id',
    description: 'Employee record identifier (UUID)',
    example: 'f3c6df52-9d13-4d7b-a2d1-9f8d4c2c8a9b',
  })
  @ApiOkResponse({
    description: 'Employee updated',
    type: EmployeeResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'Validation error: blank fields, a non-boolean active, or a change attempt on employeeNumber',
    type: ErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'No employee with this id belongs to the caller’s organization',
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing, invalid, or expired access token',
    type: ErrorResponseDto,
  })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateEmployeeDto,
    @CurrentActor() actor: AuthenticatedActor,
  ): Promise<EmployeeResponseDto> {
    return this.employeesService.update(actor.organizationId, id, dto);
  }

  /**
   * DELETE /employees/:id — ARCHIVE, not erase (design D5): the record stays
   * with active=false, the number stays reserved, and every event that
   * references it remains readable and unchanged. Idempotent — archiving an
   * already-archived employee answers 204 again.
   */
  @ApiForbiddenResponse({ description: 'Requires the ADMIN role or higher', type: ErrorResponseDto })
  @Roles(MembershipRole.ADMIN)
  @ApiRoles(MembershipRole.ADMIN)
  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Archive an employee',
    description:
      'Sets the employee inactive. The record is never removed — history keeps ' +
      'its meaning and the number stays reserved for this organization. ' +
      'Idempotent: archiving an already-archived employee is a 204 as well.',
  })
  @ApiParam({
    name: 'id',
    description: 'Employee record identifier (UUID)',
    example: 'f3c6df52-9d13-4d7b-a2d1-9f8d4c2c8a9b',
  })
  @ApiNoContentResponse({
    description: 'Employee archived (or already archived)',
  })
  @ApiNotFoundResponse({
    description: 'No employee with this id belongs to the caller’s organization',
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Missing, invalid, or expired access token',
    type: ErrorResponseDto,
  })
  async archive(
    @Param('id') id: string,
    @CurrentActor() actor: AuthenticatedActor,
  ): Promise<void> {
    await this.employeesService.archive(actor.organizationId, id);
  }
}
