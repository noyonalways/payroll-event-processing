import { Injectable } from '@nestjs/common';
import { PayrollEventStrategy } from '../payroll-event.strategy';
import { HandlerInput, ProcessingResult } from '../processing.types';
import { SimulatedPayrollProvider } from '../simulated-payroll-provider';

interface SalaryChangePayload {
  employeeId: string;
  effectiveDate: string;
  newSalary: number;
  currency: string;
}

@Injectable()
export class SalaryChangeHandler implements PayrollEventStrategy {
  constructor(private readonly provider: SimulatedPayrollProvider) {}

  async handle(input: HandlerInput): Promise<ProcessingResult> {
    const payload = input.payload as unknown as SalaryChangePayload;
    const { reference } = await this.provider.simulate({
      employeeId: input.employeeId,
      attempt: input.attempt,
    });
    return {
      reference,
      employeeId: input.employeeId,
      effectiveDate: payload.effectiveDate,
      acknowledged: {
        newSalary: payload.newSalary,
        currency: payload.currency,
      },
    };
  }
}