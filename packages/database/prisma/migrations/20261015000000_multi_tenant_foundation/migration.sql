-- Multi-tenant foundation: organizations, users, memberships, refresh tokens, and
-- an `organization_id` discriminator on every tenant-owned row.
--
-- Apply order matters: the tenant tables and the legacy tenant must exist BEFORE
-- the discriminator is backfilled, and the discriminator must be NOT NULL before
-- the tenant-qualified unique keys replace the global ones.
--
-- Two unique keys change meaning, and both were cross-tenant bugs waiting to happen:
--   * payroll_events (employee_id, sequence) → (organization_id, employee_id, sequence)
--     Two tenants using the same employee number must not share a sequence space.
--   * idempotency_records (scope, key) → (organization_id, scope, key)
--     Without the organization, a client-chosen key colliding across tenants would
--     serve the FIRST tenant's stored response body to the second tenant.

-- CreateEnum
CREATE TYPE "MembershipRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');

-- ─── Tenancy ──────────────────────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "role" "MembershipRole" NOT NULL DEFAULT 'MEMBER',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_user_id_organization_id_key" ON "memberships"("user_id", "organization_id");

-- CreateIndex
CREATE INDEX "memberships_organization_id_idx" ON "memberships"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_organization_id_idx" ON "refresh_tokens"("organization_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_expires_at_idx" ON "refresh_tokens"("expires_at");

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Discriminator backfill ───────────────────────────────────────────────────
-- Rows written before multi-tenancy need an owner. A single deterministic "legacy"
-- tenant adopts them. It is created ONLY when there is something to adopt, so a
-- fresh database never gets a phantom organization with no members.

INSERT INTO "organizations" ("id", "name", "slug", "created_at", "updated_at")
SELECT
    '00000000-0000-0000-0000-000000000001',
    'Legacy Tenant',
    'legacy',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
WHERE EXISTS (SELECT 1 FROM "payroll_events")
   OR EXISTS (SELECT 1 FROM "idempotency_records");

-- Nullable first: the column is added before the backfill can populate it.
ALTER TABLE "payroll_events" ADD COLUMN "organization_id" TEXT;
ALTER TABLE "idempotency_records" ADD COLUMN "organization_id" TEXT;

UPDATE "payroll_events"
   SET "organization_id" = '00000000-0000-0000-0000-000000000001'
 WHERE "organization_id" IS NULL;

UPDATE "idempotency_records"
   SET "organization_id" = '00000000-0000-0000-0000-000000000001'
 WHERE "organization_id" IS NULL;

-- Tenancy must be explicit on every future write: no DEFAULT on this column.
ALTER TABLE "payroll_events" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "idempotency_records" ALTER COLUMN "organization_id" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "payroll_events" ADD CONSTRAINT "payroll_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Tenant-qualified keys replace global ones ────────────────────────────────

-- DropIndex
DROP INDEX "payroll_events_employee_id_sequence_key";
DROP INDEX "idempotency_records_scope_key_key";

-- CreateIndex
CREATE UNIQUE INDEX "payroll_events_organization_id_employee_id_sequence_key" ON "payroll_events"("organization_id", "employee_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_organization_id_scope_key_key" ON "idempotency_records"("organization_id", "scope", "key");

-- ─── Tenant-leading indexes ───────────────────────────────────────────────────
-- Every tenant-scoped query filters on organization_id first, so the leading
-- column must be the organization for these indexes to be usable.

-- DropIndex
DROP INDEX "payroll_events_status_idx";
DROP INDEX "payroll_events_employee_id_created_at_idx";

-- CreateIndex
CREATE INDEX "payroll_events_organization_id_status_idx" ON "payroll_events"("organization_id", "status");

-- CreateIndex
CREATE INDEX "payroll_events_organization_id_employee_id_created_at_idx" ON "payroll_events"("organization_id", "employee_id", "created_at");

-- ─── Audit trail integrity ────────────────────────────────────────────────────
-- event_attempts.event_id was an unenforced indexed column; the FK makes the trail
-- impossible to orphan and lets an organization deletion clean up its attempts.

-- AddForeignKey
ALTER TABLE "event_attempts" ADD CONSTRAINT "event_attempts_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "payroll_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
