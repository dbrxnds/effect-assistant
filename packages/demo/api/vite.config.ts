import { defineConfig } from "vite-plus"

export default defineConfig({
  test: {
    // @effect/vitest imports `vitest`: this makes it the runner's own copy, the one vite-plus re-exports.
    alias: { vitest: "vite-plus/test" },
    server: { deps: { inline: ["@effect/vitest"] } }
  },
  // One file for `node dist/main.js`: workspace packages export TypeScript sources, so they're bundled too.
  pack: {
    entry: ["src/main.ts"],
    format: "esm",
    platform: "node",
    sourcemap: true,
    dts: false,
    outDir: "dist",
    clean: true,
    deps: { alwaysBundle: [/.*/], neverBundle: ["pg-native"] }
  }
})
