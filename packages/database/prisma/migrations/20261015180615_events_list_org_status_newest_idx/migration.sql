-- CreateIndex
CREATE INDEX "payroll_events_organization_id_status_created_at_id_idx" ON "payroll_events"("organization_id", "status", "created_at" DESC, "id" DESC);
