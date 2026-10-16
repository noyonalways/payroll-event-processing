import { Injectable } from '@nestjs/common';
import { DomainKind, Prisma } from '@prisma/client';
import { PayrollEventStrategy } from '../payroll-event.strategy';
import { HandlerInput, ProcessingResult } from '@repo/shared';
import { SimulatedPayrollProvider } from '../simulated-payroll-provider';
import { EmployeeDomainStateWriter } from '../employee-domain-state.writer';

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
  constructor(
    private readonly provider: SimulatedPayrollProvider,
    private readonly stateWriter: EmployeeDomainStateWriter,
  ) {}

  /**
   * Provider call first (design D4): a failure re-throws before any state
   * write; the write goes through the claim's transaction client, committing
   * only with the event's terminal `success` (reliability R4/R5).
   */
  async handle(
    input: HandlerInput,
    tx: Prisma.TransactionClient,
  ): Promise<ProcessingResult> {
    const payload = input.payload as unknown as AddressChangePayload;
    const { reference } = await this.provider.simulate({
      employeeId: input.employeeId,
      attempt: input.attempt,
    });
    await this.stateWriter.record(tx, {
      organizationId: input.organizationId,
      employeeId: input.employeeId,
      domain: DomainKind.ADDRESS,
      effectiveDate: payload.effectiveDate,
      value: {
        street: payload.street,
        city: payload.city,
        postalCode: payload.postalCode,
        country: payload.country,
      },
      sourceEventId: input.eventId,
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
