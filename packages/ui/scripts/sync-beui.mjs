// Vendors every beUI component (https://beui.dev) into packages/ui.
//
// Fetches the live registry, merges all 283 files, rewrites the upstream `@/`
// aliases to `@beui/`, writes each file under src/, and emits a manifest of the
// slugs, folders and dependencies for the barrel/exports generators.
//
// Run via `pnpm sync:beui`. Re-running is safe: shared helpers are byte-identical
// across the registry items that ship them, and the first writer wins.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const REGISTRY = "https://beui.dev/r/registry.json";
const UI_SRC = process.argv[2] ?? "src";
const MANIFEST = process.argv[3] ?? ".beui-manifest.json";

/** Vanilla `shadcn init` aliases @/components, @/lib, @/hooks to src/*. We map
 * them onto @beui/* so the vendored source never has to share the app's `@`. */
function rewrite(content) {
  return content
    .replace(/(["'])@\/lib\//g, "$1@beui/lib/")
    .replace(/(["'])@\/hooks\//g, "$1@beui/hooks/")
    .replace(/(["'])@\/components\//g, "$1@beui/components/");
}

const index = await (await fetch(REGISTRY)).json();
const slugs = index.items.map((i) => i.name);

const items = await Promise.all(
  slugs.map(async (slug) => {
    const res = await fetch(`https://beui.dev/r/${slug}.json`);
    if (!res.ok) throw new Error(`${slug}: HTTP ${res.status}`);
    return { slug, data: await res.json() };
  })
);

// path -> { content, type, owners[] }. First writer wins for byte content:
// shared helpers such as lib/ease.ts are byte-identical across every registry
// item that ships them, so the merge cannot lose a variation.
const files = new Map();
/** componentDir slug -> folder under src (e.g. "table" -> "components/motion/table") */
const dirOwners = new Map();

for (const { slug, data } of items) {
  for (const f of data.files ?? []) {
    let entry = files.get(f.path);
    if (!entry) {
      entry = { content: f.content, type: f.type, target: f.target, owners: [] };
      files.set(f.path, entry);
    }
    entry.owners.push(slug);
  }

  // A component's canonical folder: the directory of its registry:component
  // file, ignoring `index.tsx` (which lives beside its siblings).
  const primary = (data.files ?? []).find(
    (f) => f.type === "registry:component" && /\.tsx?$/.test(f.path)
  );
  if (primary) {
    const dir = path.posix.dirname(primary.path);
    dirOwners.set(slug, dir);
  }
}

let written = 0;
for (const [rel, entry] of files) {
  const outPath = path.join(UI_SRC, rel);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, rewrite(entry.content ?? ""), "utf8");
  written += 1;
}

const deps = [...new Set(items.flatMap((i) => i.data.dependencies ?? []))].sort();

await mkdir(path.dirname(MANIFEST), { recursive: true });
await writeFile(
  MANIFEST,
  JSON.stringify(
    {
      slugs,
      dirs: Object.fromEntries(dirOwners),
      deps,
      files: [...files.keys()].sort(),
    },
    null,
    2
  ),
  "utf8"
);

console.log(`wrote ${written} files, ${slugs.length} slugs, dirs=${dirOwners.size}`);
console.log(`deps: ${deps.join(", ")}`);
