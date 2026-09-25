import { existsSync } from "node:fs"
import { defineConfig } from "vite-plus"

// Tests call the real model. The key comes from the repo's .env.local.
const envFile = new URL("../../.env.local", import.meta.url)

if (existsSync(envFile)) process.loadEnvFile(envFile)

export default defineConfig({
  test: {
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // @effect/vitest imports `vitest`: this makes it the runner's own copy, the one vite-plus re-exports.
    alias: { vitest: "vite-plus/test" },
    server: { deps: { inline: ["@effect/vitest"] } }
  },
  // One module per source module, like effect: `dist/X.js` with its `.d.ts`, and maps back to `src/X.ts`, which ships too.
  pack: {
    entry: ["src/*.ts"],
    unbundle: true,
    format: "esm",
    platform: "neutral",
    sourcemap: true,
    dts: { sourcemap: true },
    outDir: "dist",
    clean: true
  }
})
