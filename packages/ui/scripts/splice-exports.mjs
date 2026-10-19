// Splices the generated exports map into packages/ui/package.json, preserving
// every other field (scripts, deps, peer deps, metadata). Regenerating exports
// must never clobber the hand-maintained dependency list.
import { readFile, writeFile } from "node:fs/promises";

const [pkgPath = "package.json", exportsPath = "exports.json"] =
  process.argv.slice(2);

const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
const map = JSON.parse(await readFile(exportsPath, "utf8"));

// `.` first, then subpaths sorted so the file stays reviewable.
const ordered = {};
if (map["."]) ordered["."] = map["."];
for (const key of Object.keys(map).filter((k) => k !== ".").sort()) {
  ordered[key] = map[key];
}

pkg.exports = ordered;
await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
console.log(`exports: ${Object.keys(ordered).length} entries`);
