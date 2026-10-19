// Reapplies the small local patches that packages/ui needs on top of the
// pristine beUI source. `pnpm sync:beui` overwrites every vendored file, so
// without this step the patches silently disappear on the next sync.
//
// Each patch is anchored on exact upstream text and fails loudly if the anchor
// moves, so an upstream change surfaces here instead of degrading quietly.
import { readFile, writeFile } from "node:fs/promises";

const SRC = process.argv[2] ?? "src";

const patches = [
  {
    file: "components/motion/select.tsx",
    why: "SelectTrigger/SelectItem must forward extra DOM props so callers can attach data-testid and ARIA attributes. Upstream types them as a closed prop list.",
    edits: [
      {
        from: `export interface SelectTriggerProps {
  className?: string;
  children: ReactNode;
}

export function SelectTrigger({ className, children }: SelectTriggerProps) {`,
        to: `export interface SelectTriggerProps {
  className?: string;
  children: ReactNode;
  /** Extra DOM attributes pass through to the trigger button, so callers can
   * attach a data-testid or ARIA hook the upstream prop list does not cover. */
  [attribute: string]: unknown;
}

export function SelectTrigger({
  className,
  children,
  ...rest
}: SelectTriggerProps) {`,
      },
      {
        from: `      aria-controls={ctx.listId}
      onClick={() => ctx.setOpen(!ctx.open)}`,
        to: `      aria-controls={ctx.listId}
      {...rest}
      onClick={() => ctx.setOpen(!ctx.open)}`,
      },
      {
        from: `export interface SelectItemProps {
  value: string;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}

export function SelectItem({
  value,
  disabled = false,
  className,
  children,
}: SelectItemProps) {`,
        to: `export interface SelectItemProps {
  value: string;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
  /** Extra DOM attributes pass through to the option button. */
  [attribute: string]: unknown;
}

export function SelectItem({
  value,
  disabled = false,
  className,
  children,
  ...rest
}: SelectItemProps) {`,
      },
      {
        from: `        data-listbox-id={value}
        onClick={() => ctx.select(value)}`,
        to: `        data-listbox-id={value}
        onClick={() => ctx.select(value)}
        {...rest}`,
      },
    ],
  },
  {
    file: "components/charts/treemap/model.ts",
    why: "ResolvedNode appears in the public signatures of layoutTreemap and useTreemapModel, so it must be exported or declaration emit fails (upstream builds without declarations).",
    edits: [
      {
        from: "interface ResolvedNode {",
        to: `/** Exported because it appears in the public signatures of layoutTreemap
 * and useTreemapModel, which need to emit declarations. */
export interface ResolvedNode {`,
      },
    ],
  },
];

let applied = 0;
let skipped = 0;
const failures = [];

for (const patch of patches) {
  const path = `${SRC}/${patch.file}`;
  let text = await readFile(path, "utf8");
  let touched = 0;

  for (const { from, to } of patch.edits) {
    if (text.includes(to)) continue; // already applied
    if (!text.includes(from)) {
      failures.push(`${patch.file}: anchor not found -> ${from.split("\n")[0]}`);
      continue;
    }
    text = text.replace(from, to);
    touched += 1;
  }

  if (failures.some((f) => f.startsWith(`${patch.file}:`))) continue;
  if (touched === 0) {
    skipped += 1;
    continue;
  }
  await writeFile(path, text, "utf8");
  applied += touched;
}

if (failures.length) {
  console.error("beui patches could not be applied:\n" + failures.join("\n"));
  process.exit(1);
}

console.log(`patched ${applied} edit(s); ${skipped} file(s) already current`);
