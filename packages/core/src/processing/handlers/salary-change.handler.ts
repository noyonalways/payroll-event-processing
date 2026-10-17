import { Injectable } from '@nestjs/common';
import { DomainKind, Prisma } from '@prisma/client';
import { PayrollEventStrategy } from '../payroll-event.strategy';
import { HandlerInput, ProcessingResult } from '@repo/shared';
import { ProviderResolverService } from '../provider-resolver.service';
import { EmployeeDomainStateWriter } from '../employee-domain-state.writer';

interface SalaryChangePayload {
  employeeId: string;
  effectiveDate: string;
  newSalary: number;
  currency: string;
}

@Injectable()
export class SalaryChangeHandler implements PayrollEventStrategy {
  constructor(
    private readonly providerResolver: ProviderResolverService,
    private readonly stateWriter: EmployeeDomainStateWriter,
  ) {}

  /**
   * The simulated external call runs FIRST (design D4): a provider failure
   * re-throws before any state write, so the state row appears exactly when
   * the external operation was acknowledged — and, being written through the
   * claim's transaction client, commits only with the event's terminal
   * `success` (reliability R4/R5).
   */
  async handle(
    input: HandlerInput,
    tx: Prisma.TransactionClient,
  ): Promise<ProcessingResult> {
    const payload = input.payload as unknown as SalaryChangePayload;
    const { kind, provider } = await this.providerResolver.for(input.organizationId);
    void kind;
    const { reference } = await provider.apply({
      organizationId: input.organizationId,
      eventId: input.eventId,
      eventType: input.eventType,
      employeeId: input.employeeId,
      sequence: input.sequence,
      payload: input.payload,
      attempt: input.attempt,
    });
    await this.stateWriter.record(tx, {
      organizationId: input.organizationId,
      employeeId: input.employeeId,
      domain: DomainKind.COMPENSATION,
      effectiveDate: payload.effectiveDate,
      value: { newSalary: payload.newSalary, currency: payload.currency },
      sourceEventId: input.eventId,
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
