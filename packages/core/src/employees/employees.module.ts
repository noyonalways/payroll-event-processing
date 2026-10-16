import { Module } from '@nestjs/common';
import { EmployeesController } from './employees.controller';
import { EmployeesService } from './employees.service';

/**
 * The organization employee directory (employee-directory). Scoped HTTP CRUD
 * over the `employees` table — no queue, no background work: the submission
 * gate in `EventsService` reads the rows, and registration in `AuthService`
 * seeds the demo ones. PrismaModule is global, as everywhere else in core.
 */
@Module({
  controllers: [EmployeesController],
  providers: [EmployeesService],
  exports: [EmployeesService],
})
export class EmployeesModule {}
