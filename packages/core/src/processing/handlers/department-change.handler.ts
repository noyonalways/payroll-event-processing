import { Injectable } from '@nestjs/common';
import { PayrollEventStrategy } from '../payroll-event.strategy';
import { HandlerInput, ProcessingResult } from '@repo/shared';
import { SimulatedPayrollProvider } from '../simulated-payroll-provider';

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