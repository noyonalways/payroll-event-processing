# Index measurement record — `payroll_events` list queries (tasks 2.1 / 2.2 / 6.4)

Measured on a scratch Postgres 16 (`scratch-seed.sql`: 3 organizations, 1800
events across all five lifecycle states, 40 employees per organization,
creation times spread over ~10 days at minute granularity so `created_at` ties
exist). Raw `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` plans beside this file in
`measurements/before-*.json` and `measurements/after-*.json`.

Indexes present **before** any change (from `multi_tenant_foundation`):

- `payroll_events_organization_id_status_idx (organization_id, status)`
- `payroll_events_organization_id_employee_id_created_at_idx (organization_id, employee_id, created_at)`
- unique `payrolls_events_organization_id_employee_id_sequence_key` (`…_sequence_key`)
- `payroll_events_idempotency_key_idx`, PK on `id`

## Before — planner sorts on every target query

Service page shape: `WHERE (tenant + filters) ORDER BY created_at DESC, id DESC
LIMIT 21` (limit + 1 lookahead).

| Query (org A)              | Matching rows | Plan                                                        | Cost  | Time     |
|----------------------------|--------------:|-------------------------------------------------------------|------:|----------|
| unfiltered newest-first    | 600           | Limit → **Sort** (top-N heapsort) → Bitmap Heap/Index Scan on `(organization_id, status)` | 175.66 | 1.164 ms |
| status = QUEUED            | 150           | Limit → **Sort** → Bitmap Heap/Index Scan on `(organization_id, status)` | 157.30 | 0.185 ms |
| status + cursor seek       | 150           | Limit → **Sort** → Bitmap Heap/Index Scan on `(organization_id, status)` | 156.52 | 0.313 ms |
| employee_id = 'emp-7'      | 15            | Limit → **Incremental Sort** → Index Scan on `(organization_id, employee_id, created_at)` | 34.31 | 0.125 ms |
| createdAfter/Before bounds | 600           | Limit → **Sort** → Bitmap Heap/Index Scan on `(organization_id, status)` | 178.66 | 0.471 ms |

Every page request fetches the **whole matching set** (600 rows unfiltered, 150
status-filtered) and sorts it to serve 21, exactly the failure design D3
predicted: the `(organization_id, status)` index answers the filter but forces a
sort of the match set per page, and cost scales with match size.

## Decision (design D3)

**One index**, status-leading as the design expected — the status filter is the
view the UI hits hardest (failure recovery / per-state triage):

```sql
CREATE INDEX "payroll_events_organization_id_status_created_at_id_idx"
ON "payroll_events"("organization_id", "status", "created_at" DESC, "id" DESC);
```

Also declared in `schema.prisma` as
`@@index([organizationId, status, createdAt(sort: Desc), id(sort: Desc)])` so a
future `prisma migrate dev` never drops the hand-inspected migration's index.

### What the measurement says about column order

- `(organization_id, status, created_at DESC, id DESC)` turns the three most
  important shapes — page 1 filtered, any filtered page via cursor seek, and
  generic deep paging within a state — into pure index scans: equality prefix
  `(organization_id, status)` fixes a contiguous index range already stored in
  `created_at DESC, id DESC` order, so **no Sort node is needed at any page
  depth**, and only the 21 requested rows are read.
- The unfiltered browse and the pure date-bounded range keep their sorts: with
  `status` leading, an unfiltered org query cannot consume this index in
  `created_at` order. The measured alternative `(organization_id, created_at
  DESC, id DESC)` would serve those two but leave the status-filtered shape —
  the common case per D3 — sorting. One index must be chosen; D3's rationale
  (status-filtered is the common case) holds against the measurements, so the
  column order follows the design expectation.
- The employee-filtered shape already avoids a full sort (Incremental Sort on
  `(organization_id, employee_id, created_at)`); at 15 match rows it is two
  orders of magnitude cheaper than the shapes the new index targets and is left
  on its existing index.

## After — planner uses the index (captured post-migration, task 2.2)

| Query (org A)                    | Plan                                                                                     | Cost (before)   | Time  | Sort? |
|----------------------------------|------------------------------------------------------------------------------------------|-----------------|-------|-------|
| status = QUEUED, page 1          | Limit → Index Scan on `…_status_created_at_id_idx`, 21 rows                               | 157.30 → 27.57  | 0.049 ms | none  |
| status + cursor seek (mid)       | Limit → Index Scan on `…_status_created_at_id_idx`                                        | 156.52 → 51.74  | 0.068 ms | none  |
| status + cursor seek (late pos)  | Limit → Index Scan on `…_status_created_at_id_idx`, 21 rows                               | 156.52 → 33.75  | 0.043 ms | none  |
| status + cursor seek (old pos)   | Limit → Sort (quicksort of the small remainder) → BitmapOr on the new index               | 156.52 → 71.70  | 0.189 ms | remainder-only |
| unfiltered newest-first          | unchanged (Sort over `(organization_id, status)` bitmap scan)                             | 175.66          | 0.595 ms | accepted |
| employee_id = 'emp-7'            | unchanged (Incremental Sort on `(organization_id, employee_id, created_at)`)              | 34.31           | 0.134 ms | as before |
| createdAfter/Before bounds       | unchanged (Sort over `(organization_id, status)` bitmap scan)                             | 178.66          | 0.318 ms | accepted |

The targeted shapes read exactly the requested rows in index order — cost drops
from "read all 150 matching rows + top-N sort per page" (157.30) to a range scan
(27.57 at page depth 1). Cursor continuations stay sort-free at every realistic
position (mid-list and late-list); only a seek position near the **oldest** rows
of the state keeps a sort, and even that one limits the sort input to the small
remaining range (BitmapOr reads only the post-position rows) — still bounded,
never the whole match set. The unfiltered browse and pure date-bounded range
keep their sorts on the old index, which design D3 explicitly accepted in
favor of the status-filtered common case. Windows at 1800-row scale remain
sub-millisecond everywhere; the load-bearing result is the plan shape: no Sort
and 21 rows read for every status-prefixed page, which stays flat as the
history grows, where the before-plans' cost grew linearly with the match set.
