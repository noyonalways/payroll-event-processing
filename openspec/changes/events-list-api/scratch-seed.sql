-- Scratch measurement dataset (EXPLAIN gate, events-list-api task 2.1).
-- Wipes only the measurement data it created: three organizations, ~1800
-- payroll events across all five lifecycle states, 40 employees per
-- organization, creation times spread over 60 days at minute granularity.
DELETE FROM event_attempts;
DELETE FROM idempotency_records;
DELETE FROM payroll_events;
DELETE FROM organizations;

INSERT INTO organizations (id, name, slug, created_at, updated_at)
VALUES
  ('11111111-1111-1111-1111-111111111111', 'Measure Org A', 'measure-org-a', now(), now()),
  ('22222222-2222-2222-2222-222222222222', 'Measure Org B', 'measure-org-b', now(), now()),
  ('33333333-3333-3333-3333-333333333333', 'Measure Org C', 'measure-org-c', now(), now());

-- 600 events per organization = 1800 rows. Status weighted toward the
-- in-flight/terminal mix a live system shows (3/8 SUCCESS, 2/8 QUEUED, 1/8
-- each RECEIVED / PROCESSING / FAILED). Ties on created_at are deliberate
-- (minute truncation) so the id tiebreaker matters.
INSERT INTO payroll_events (
  id, organization_id, event_type, employee_id, payload, sequence,
  idempotency_key, status, created_at, updated_at, processed_at
)
SELECT
  gen_random_uuid()::text,
  s.org_id,
  (ARRAY['BANK_ACCOUNT_CHANGE','ADDRESS_CHANGE','SALARY_CHANGE','DEPARTMENT_CHANGE'])[1 + s.g % 4],
  'emp-' || (1 + s.g % 40),
  jsonb_build_object(
    'employeeId', 'emp-' || (1 + s.g % 40),
    'effectiveDate', '2026-09-01',
    'iban-like', 'DE89' || lpad((s.g * 7 % 100000)::text, 5, '0')
  ),
  s.seq,
  'seed-' || s.org_id || '-' || s.g,
  (ARRAY['RECEIVED','QUEUED','PROCESSING','SUCCESS','SUCCESS','SUCCESS','FAILED','QUEUED']::"EventStatus"[])[1 + s.g % 8],
  s.ts,
  s.ts + interval '10 seconds',
  CASE WHEN (ARRAY['RECEIVED','QUEUED','PROCESSING','SUCCESS','SUCCESS','SUCCESS','FAILED','QUEUED']::"EventStatus"[])[1 + s.g % 8] = 'SUCCESS'
       THEN s.ts + interval '1 minute' END
FROM (
  SELECT
    g,
    o.org_id,
    date_trunc('minute', to_timestamp(1760000000 + (g * 1511 + o.n * 7) % (86400::bigint * 60))) AS ts,
    row_number() OVER (
      PARTITION BY o.org_id, (1 + g % 40)
      ORDER BY date_trunc('minute', to_timestamp(1760000000 + (g * 1511 + o.n * 7) % (86400::bigint * 60)))
    ) AS seq
  FROM generate_series(1, 600) g
  CROSS JOIN (
    VALUES
      ('11111111-1111-1111-1111-111111111111', 1),
      ('22222222-2222-2222-2222-222222222222', 2),
      ('33333333-3333-3333-3333-333333333333', 3)
  ) o(org_id, n)
) s
ORDER BY s.org_id, s.ts;

-- A second-tenant employee id that collides with org A's ('emp-7') so the
-- employee-scoped query's tenant isolation is measurable.
SELECT count(*) AS total_events,
       count(*) FILTER (WHERE status = 'QUEUED') AS queued,
       count(*) FILTER (WHERE status = 'FAILED') AS failed
FROM payroll_events;
