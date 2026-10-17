import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FailureConfig, SimulatedPayrollProvider } from './simulated-payroll-provider';
import { HandlerRegistry } from './handler-registry';
import { EventClaim } from './event-claim';
import { EmployeeDomainStateWriter } from './employee-domain-state.writer';
import { BankAccountChangeHandler } from './handlers/bank-account-change.handler';
import { AddressChangeHandler } from './handlers/address-change.handler';
import { SalaryChangeHandler } from './handlers/salary-change.handler';
import { DepartmentChangeHandler } from './handlers/department-change.handler';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { ProviderHttpClient } from './provider-http.client';
import { ProviderResolverService } from './provider-resolver.service';

/**
 * Processing strategies + simulated provider, shared by the worker and (when
 * needed) the API. `ConfigModule.forRoot` is global in both apps, so the
 * `FailureConfig` factory can inject `ConfigService` here without importing it.
 */
@Module({
  imports: [WebhooksModule],
  providers: [
    {
      provide: FailureConfig,
      useFactory: (config: ConfigService) => FailureConfig.fromEnv(config),
      inject: [ConfigService],
    },
    SimulatedPayrollProvider,
    ProviderHttpClient,
    ProviderResolverService,
    HandlerRegistry,
    EventClaim,
    EmployeeDomainStateWriter,
    BankAccountChangeHandler,
    AddressChangeHandler,
    SalaryChangeHandler,
    DepartmentChangeHandler,
  ],
  exports: [HandlerRegistry, EventClaim, SimulatedPayrollProvider, FailureConfig, ProviderResolverService],
})
export class ProcessingModule {}