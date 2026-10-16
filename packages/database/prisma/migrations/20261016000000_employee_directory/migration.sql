-- Employee directory: one `employees` row per (organization, employee number).
--
-- The directory is the caller-owned roster that event payloads reference as
-- `employeeId` (employee-directory change, design D2/D8). Three statements:
--   (a) the table — unique (organization_id, employee_number) keeps numbers
--       tenant-LOCAL and reserved even after archiving; cascade FK keeps the
--       directory tenant-owned;
--   (b) adopt the identifiers history already uses — every employee id observed
--       in payroll_events becomes an active directory row (name unknown ⇒ NULL),
--       so existing submissions keep passing the new submission gate (design D8:
--       no deploy-time burst of permanent rejections for ids that were legal a
--       moment ago);
--   (b)/(c) are re-runnable by design: the NOT EXISTS guards make re-running a
--   no-op for anything already present.
--   (c) seed the five reserved `EMP-DEMO-*` scenario employees (demo-scenarios.ts
--       in @repo/shared is the source of these identifiers) for every
--       organization, so the documented demo lever and the UI scenario selector
--       keep working under the gate. Registration seeds the same rows for orgs
--       created after this migration.

-- CreateTable
CREATE TABLE "employees" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "employee_number" TEXT NOT NULL,
    "name" TEXT,
    "department" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateIndex — also serves the directory listing's number-ascending keyset seek
CREATE UNIQUE INDEX "employees_organization_id_employee_number_key" ON "employees"("organization_id", "employee_number");

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- (b) Adopt observed employee ids from event history (name unknown ⇒ NULL)
INSERT INTO "employees" ("id", "organization_id", "employee_number", "name", "department", "active", "created_at", "updated_at")
SELECT
    gen_random_uuid()::text,
    p."organization_id",
    p."employee_id",
    NULL,
    NULL,
    true,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM (
    SELECT DISTINCT "organization_id", "employee_id" FROM "payroll_events"
) AS p
WHERE NOT EXISTS (
    SELECT 1 FROM "employees" e
    WHERE e."organization_id" = p."organization_id"
      AND e."employee_number" = p."employee_id"
);

-- (c) Seed the five reserved EMP-DEMO-* scenario employees for every organization
INSERT INTO "employees" ("id", "organization_id", "employee_number", "name", "department", "active", "created_at", "updated_at")
SELECT
    gen_random_uuid()::text,
    o."id",
    s."number",
    s."name",
    'Demo',
    true,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "organizations" o
CROSS JOIN (VALUES
    ('EMP-DEMO-SUCCESS',   'Demo employee (success)'),
    ('EMP-DEMO-RECOVER',   'Demo employee (recover)'),
    ('EMP-DEMO-TRANSIENT', 'Demo employee (transient)'),
    ('EMP-DEMO-FAILAFTER', 'Demo employee (fail-after-retries)'),
    ('EMP-DEMO-PERMANENT', 'Demo employee (permanent)')
) AS s("number", "name")
WHERE NOT EXISTS (
    SELECT 1 FROM "employees" e
    WHERE e."organization_id" = o."id"
      AND e."employee_number" = s."number"
);
