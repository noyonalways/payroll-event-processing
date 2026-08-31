import { Injectable } from '@nestjs/common';
import { SimulatedPayrollProvider } from '../simulated-payroll-provider';
import { HandlerInput, ProcessingResult } from '../processing.types';
import { PayrollEventStrategy } from '../payroll-event.strategy';

interface DepartmentChangePayload {
  employeeId: string;
  effectiveDate: string;
  newDepartment: string;
}

@Injectable()
export class DepartmentChangeHandler implements PayrollEventStrategy {
  constructor(private readonly provider: SimulatedPayrollProvider) {}

  async handle(input: HandlerInput): Promise<ProcessingResult> {
    const payload = input.payload as unknown as DepartmentChangePayload;
    const { reference } = await this.provider.simulate({
      employeeId: input.employeeId,
      attempt: input.attempt,
    });

    return {
      reference,
      employeeId: input.employeeId,
      effectiveDate: payload.effectiveDate,
      acknowledged: {
        newDepartment: payload.newDepartment,
      },
    };
  }
}
