# @repo/ui

The shared UI library for every app in this monorepo. It vendors the complete
[beUI](https://beui.dev) component set so any app — web, future admin console,
internal tool — renders the same controls, motion, and tokens.

## What is in here

| Area | Path | Components |
| --- | --- | --- |
| beUI motion components | `src/components/motion` | 110 |
| beUI agent/AI components | `src/components/agents` | 20 |
| beUI charts | `src/components/charts` | 13 |
| Shared helpers (ease, hooks, utils) | `src/lib` | 20 files |
| App chrome (non-beUI) | `src/app` | shadcn-token `Button` |

143 components, 285 vendored source files.

```ts
import { Button, Card, Loader } from "@repo/ui";          // root barrel
import { ChatApp } from "@repo/ui/chat-app";               // by slug (preferred)
import { Button } from "@repo/ui/button";
import { cn } from "@repo/ui/lib/utils";
```

Prefer the **slug subpath** — it keeps imports explicit and lets the bundler
tree-shake. The slugs match beUI's registry names exactly
(`https://beui.dev/r/<slug>.json`), so anything on beui.dev maps 1:1 to
`@repo/ui/<slug>`.

## Consuming it from an app

Apps resolve `@repo/ui` to **source**, not `dist`. Add the alias and condition in
both the Vite and Vitest configs (see `apps/web/vite.config.ts`):

```ts
resolve: {
  // `source` outranks `import`, so @repo/ui resolves to src, never dist.
  conditions: ['source', 'import', 'module', 'browser', 'default'],
  alias: [{ find: '@beui', replacement: path.resolve(..., 'packages/ui/src') }],
}
```

Why source-first: the vendored components keep beUI's upstream `@beui/*` imports.
Those resolve into `packages/ui/src`, so there is exactly one copy of every
component. Pointing an app at `dist` instead invites a stale build — the kind
where typecheck passes and the app ships yesterday's component.

The app also needs the `@beui/*` path mapping in its `tsconfig`:

```json
"paths": { "@beui/*": ["../../packages/ui/src/*"] }
```

## Vendored, not forked

The files under `src/components` and `src/lib` are **verbatim beUI source**,
except for two mechanical rewrites and a short list of patches:

- `@/lib/*`, `@/hooks/*`, `@/components/*` → `@beui/*` (avoids colliding with an
  app's own `@` alias, which points at that app's `src`).
- Nothing else. Imports, formatting, and comments stay as published.

That is deliberate: keeping the source byte-identical to upstream is what makes
`pnpm sync:beui` safe to re-run.

## Re-syncing from beUI

```bash
pnpm --filter @repo/ui sync:beui
```

This one command:

1. Fetches `https://beui.dev/r/registry.json` and every component JSON.
2. Writes all ~283 files, merging shared helpers (they are byte-identical across
   the registry items that ship them, so the first writer wins).
3. Rewrites the aliases to `@beui/*`.
4. Regenerates `src/index.ts` (the barrel) and `exports.json` (the subpath map).
5. Splices the subpath map into `package.json`, preserving deps and scripts.
6. Reapplies the local patches from `scripts/apply-beui-patches.mjs`.

Run `pnpm --filter @repo/ui typecheck && pnpm --filter @repo/ui build` afterwards.

### The patch list

`sync:beui` overwrites every vendored file, so local fixes must be re-declared
in `scripts/apply-beui-patches.mjs` or they vanish. That script anchors each edit
on exact upstream text and fails loudly if the anchor moves — an upstream change
becomes a build error, not silent drift. Current patches:

| File | Why |
| --- | --- |
| `components/motion/select.tsx` | `SelectTrigger`/`SelectItem` forward extra DOM props, so callers can attach `data-testid` and ARIA attributes. Upstream types them as a closed prop list. |
| `components/charts/treemap/model.ts` | `ResolvedNode` is exported because it appears in the public signatures of `layoutTreemap` and `useTreemapModel`; declaration emit fails otherwise. Upstream builds without declarations. |

Keep this list short. If a fix could live in an app instead, put it there — the
whole point of vendoring is that the tree stays upstream-faithful.

### Resolving slugs

A beUI slug does not always match a filename, so the generator resolves by
looking at what actually exists:

- flat file → `motion/alert.tsx`
- folder with an index → `motion/table/index.tsx`
- folder of peers → `motion/not-found/glitch.tsx` (slug `not-found-glitch`)
- several slugs in one folder → `motion/button/*` (4 slugs), `agents/loading-states/*` (3)

`@repo/ui/button` is also exposed by hand, because the four registry button slugs
share one folder and callers want the family from one path.

## Rules for contributors

- Import from `@repo/ui/<slug>` in apps. Do not reach into `packages/ui/src`
  with relative paths.
- Add a component by re-running `sync:beui`, not by hand-copying files.
- Need a behavioural change? Patch it in `scripts/apply-beui-patches.mjs` with a
  comment explaining why, or wrap the component in the app.
- Never rename an existing slug — apps import it.
