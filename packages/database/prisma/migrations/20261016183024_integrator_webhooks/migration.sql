-- CreateEnum
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('PENDING', 'DELIVERED', 'DEAD_LETTERED');

-- CreateEnum
CREATE TYPE "WebhookTerminalStatus" AS ENUM ('SUCCESS', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WebhookDeliveryAttemptOutcome" AS ENUM ('DELIVERED', 'FAILED');

-- CreateTable
CREATE TABLE "webhook_endpoints" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "webhook_endpoint_id" TEXT,
    "event_id" TEXT NOT NULL,
    "terminal_status" "WebhookTerminalStatus" NOT NULL,
    "payload" JSONB NOT NULL,
    "url" TEXT NOT NULL,
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "dead_letter_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_delivery_attempts" (
    "id" TEXT NOT NULL,
    "delivery_id" TEXT NOT NULL,
    "attempt_number" INTEGER NOT NULL,
    "outcome" "WebhookDeliveryAttemptOutcome" NOT NULL,
    "response_status" INTEGER,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_delivery_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "webhook_endpoints_organization_id_active_idx" ON "webhook_endpoints"("organization_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_endpoints_organization_id_label_key" ON "webhook_endpoints"("organization_id", "label");

-- CreateIndex
CREATE INDEX "webhook_deliveries_status_next_attempt_at_idx" ON "webhook_deliveries"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "webhook_deliveries_organization_id_created_at_idx" ON "webhook_deliveries"("organization_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "webhook_delivery_attempts_delivery_id_idx" ON "webhook_delivery_attempts"("delivery_id");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_delivery_attempts_delivery_id_attempt_number_key" ON "webhook_delivery_attempts"("delivery_id", "attempt_number");

-- AddForeignKey
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_endpoint_id_fkey" FOREIGN KEY ("webhook_endpoint_id") REFERENCES "webhook_endpoints"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_delivery_attempts" ADD CONSTRAINT "webhook_delivery_attempts_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "webhook_deliveries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
