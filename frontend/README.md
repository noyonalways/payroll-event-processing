# Payroll Events — demo UI

Two-pane React demo for the payroll event-processing API (`/events`). Submit
typed payroll events and watch them progress
`received → queued → processing → success | failed` through live polling, with
a detail panel showing the processing result and the failure trail (retries,
`errorType`, `failedReason`).

## What a reviewer sees

- **Submit an event** — the form is pre-filled with sample values that pass the
  API's validation (`EMP-001`, an effective date, a valid German IBAN, a Berlin
  address, `75000 EUR`). Hit **Submit event** as-is for a one-click run, or
  tweak a single field. A "Reset" button restores the samples; clearing a
  required field surfaces the local validation; a structured API `400` is shown
  inline without losing what you typed.
- **Tracked events** — every submission lands here with its status badge,
  per-employee sequence, and attempt count; rows are polled every 3 s and the
  list survives a reload.
- **Event detail** — select a row to inspect the payload, timestamps, handler
  result, and the full append-only attempt trail.

## Run it

```bash
# Dev (Vite dev server, expects the API on http://localhost:3000)
npm --prefix frontend run dev

# API origin can be overridden at build time
VITE_API_URL=https://… npm --prefix frontend run build
```

The packaged frontend is served on `http://localhost:5173` by nginx when the
whole stack is up (`docker compose up --build`).

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server with HMR |
| `npm run build` | `tsc -b` type-check + production build to `dist/` |
| `npm run test:run` | Vitest + Testing Library (jsdom) once |
| `npm run lint` | Oxlint |

## Stack notes

- React 19 + Vite + Tailwind CSS v4 (design tokens in `src/index.css`).
- Form controls are the installed copy-paste components: beUI motion
  `Input`/`Select` (`src/components/motion/`) and shadcn `Button`
  (`src/components/ui/`). The `@/` alias maps to `src/` in both Vite and Vitest.
- `src/lib/eventTypes.ts` is the single source for the `event-submission`
  contract: field sets, validation, and the sample defaults.