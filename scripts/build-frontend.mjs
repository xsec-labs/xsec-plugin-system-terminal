import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

await build({
  entryPoints: [resolve(root, "com.xsec.desktop/frontend-src/index.ts")],
  outfile: resolve(root, "com.xsec.desktop/frontend/index.js"),
  bundle: true,
  format: "esm",
  target: ["es2022"],
  loader: { ".css": "text" },
  legalComments: "none",
  minify: true,
});
