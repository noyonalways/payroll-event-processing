-- CreateEnum
CREATE TYPE "DomainKind" AS ENUM ('COMPENSATION', 'BANK_ACCOUNT', 'ADDRESS', 'DEPARTMENT');

-- CreateTable
CREATE TABLE "employee_domain_state" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "domain" "DomainKind" NOT NULL,
    "value" JSONB NOT NULL,
    "effective_date" DATE NOT NULL,
    "source_event_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_domain_state_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "employee_domain_state_source_event_id_key" ON "employee_domain_state"("source_event_id");

-- CreateIndex
CREATE INDEX "employee_domain_state_organization_id_employee_id_domain_ef_idx" ON "employee_domain_state"("organization_id", "employee_id", "domain", "effective_date" DESC);

-- AddForeignKey
ALTER TABLE "employee_domain_state" ADD CONSTRAINT "employee_domain_state_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_domain_state" ADD CONSTRAINT "employee_domain_state_source_event_id_fkey" FOREIGN KEY ("source_event_id") REFERENCES "payroll_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
