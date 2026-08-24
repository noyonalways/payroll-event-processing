-- CreateEnum
CREATE TYPE "EventStatus" AS ENUM ('RECEIVED', 'QUEUED', 'PROCESSING', 'SUCCESS', 'FAILED');

-- CreateTable
CREATE TABLE "payroll_events" (
    "id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "sequence" BIGINT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "status" "EventStatus" NOT NULL DEFAULT 'RECEIVED',
    "response_status" INTEGER NOT NULL DEFAULT 201,
    "response_body" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "payroll_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payroll_events_idempotency_key_key" ON "payroll_events"("idempotency_key");

-- CreateIndex
CREATE INDEX "payroll_events_status_idx" ON "payroll_events"("status");

-- CreateIndex
CREATE INDEX "payroll_events_employee_id_created_at_idx" ON "payroll_events"("employee_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_events_employee_id_sequence_key" ON "payroll_events"("employee_id", "sequence");
