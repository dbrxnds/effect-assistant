/**
 * Bundle the production entry (`src/main.ts`) for `node dist/main.mjs`.
 * Workspace packages export TypeScript sources; bundling avoids `tsx` at runtime.
 */
import * as esbuild from "esbuild"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const pkgDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")

await mkdir(path.join(pkgDir, "dist"), { recursive: true })

await esbuild.build({
  entryPoints: [path.join(pkgDir, "src/main.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: path.join(pkgDir, "dist/main.mjs"),
  sourcemap: true,
  logLevel: "info",
  packages: "bundle",
  external: ["pg-native"],
  banner: {
    js: `import { createRequire } from "module";
const require = createRequire(import.meta.url);`
  }
})
