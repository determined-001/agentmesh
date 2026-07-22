// Packages apps/extension into extension.zip for sideloading / store upload.
// Usage: node scripts/pack-extension.mjs [dashboard-origin]
//   With an origin argument, rewrites host_permissions and popup.js API base
//   from localhost to that origin in the packed copy (source stays untouched).
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "apps/extension");
const out = join(root, "extension.zip");
const origin = process.argv[2];

const stage = mkdtempSync(join(tmpdir(), "agentmesh-ext-"));
cpSync(src, stage, { recursive: true });

if (origin) {
  const manifestPath = join(stage, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.host_permissions = [`${origin.replace(/\/$/, "")}/*`];
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const popupPath = join(stage, "popup.js");
  const popup = readFileSync(popupPath, "utf8").replace(
    'const API = "http://localhost:3000/api";',
    `const API = "${origin.replace(/\/$/, "")}/api";`,
  );
  writeFileSync(popupPath, popup);
  console.log(`pinned to origin ${origin}`);
}

rmSync(out, { force: true });
execFileSync("zip", ["-r", out, "."], { cwd: stage, stdio: "inherit" });
rmSync(stage, { recursive: true, force: true });
console.log(`wrote ${out}`);
