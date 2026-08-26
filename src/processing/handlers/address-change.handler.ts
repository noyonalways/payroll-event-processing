import { Injectable } from '@nestjs/common';
import { PayrollEventStrategy } from '../payroll-event.strategy';
import { HandlerInput, ProcessingResult } from '../processing.types';
import { SimulatedPayrollProvider } from '../simulated-payroll-provider';

interface AddressChangePayload {
  employeeId: string;
  effectiveDate: string;
  street: string;
  city: string;
  postalCode: string;
  country: string;
}

@Injectable()
export class AddressChangeHandler implements PayrollEventStrategy {
  constructor(private readonly provider: SimulatedPayrollProvider) {}

  async handle(input: HandlerInput): Promise<ProcessingResult> {
    const payload = input.payload as unknown as AddressChangePayload;
    const { reference } = await this.provider.simulate({
      employeeId: input.employeeId,
      attempt: input.attempt,
    });
    return {
      reference,
      employeeId: input.employeeId,
      effectiveDate: payload.effectiveDate,
      acknowledged: {
        street: payload.street,
        city: payload.city,
        postalCode: payload.postalCode,
        country: payload.country,
      },
    };
  }
}