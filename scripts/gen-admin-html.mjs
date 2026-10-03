// Regenerates supabase/functions/admin/html.ts from admin/index.html.
// The Edge Runtime bundler rejects `import ... with { type: "text" }`, so the
// panel HTML is inlined into a TS module that the admin function imports.
// Run after editing supabase/functions/admin/index.html:
//   node scripts/gen-admin-html.mjs
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const htmlPath = join(root, "supabase", "functions", "admin", "index.html");
const outPath = join(root, "supabase", "functions", "admin", "html.ts");

const src = readFileSync(htmlPath, "utf8");
const esc = src
  .replace(/\\/g, "\\\\")
  .replace(/`/g, "\\`")
  .replace(/\$\{/g, "\\${");

writeFileSync(
  outPath,
  "// GENERATED from supabase/functions/admin/index.html — do not edit by hand.\n" +
    "// Regenerate with: node scripts/gen-admin-html.mjs\n" +
    "export const ADMIN_HTML = `" + esc + "`;\n"
);

console.log("wrote", outPath, statSync(outPath).size, "bytes");
