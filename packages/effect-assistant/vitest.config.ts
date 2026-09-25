import { existsSync } from "node:fs"
import { defineConfig } from "vitest/config"

// Tests call the real model. The key comes from the repo's .env.local.
const envFile = new URL("../../.env.local", import.meta.url)

if (existsSync(envFile)) process.loadEnvFile(envFile)

export default defineConfig({
  test: { testTimeout: 120_000, hookTimeout: 60_000 }
})
