-- CreateEnum
CREATE TYPE "EventActionType" AS ENUM ('RETRY', 'CANCEL');

-- AlterEnum
ALTER TYPE "EventStatus" ADD VALUE 'CANCELLED';

-- AlterTable
ALTER TABLE "payroll_events" ADD COLUMN     "attempt_base" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "event_actions" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "action" "EventActionType" NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "event_actions_event_id_idx" ON "event_actions"("event_id");

-- AddForeignKey
ALTER TABLE "event_actions" ADD CONSTRAINT "event_actions_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "payroll_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
