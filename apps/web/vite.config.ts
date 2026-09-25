import { tanstackRouter } from "@tanstack/router-plugin/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import tsconfigPaths from "vite-tsconfig-paths"

/**
 * The chat UI: a single-page app. `pnpm dev` serves it on :3000 and proxies
 * the API (on :8787); `pnpm build` writes `dist`, which the API serves in
 * production.
 */
export default defineConfig({
  plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true }), react(), tsconfigPaths()],
  server: {
    // `true` listens on every address, so both localhost and 127.0.0.1 work.
    host: true,
    port: 3000,
    proxy: {
      "/health": "http://localhost:8787",
      "/rpc": { target: "ws://localhost:8787", ws: true }
    }
  },
  build: { outDir: "dist", emptyOutDir: true }
})
