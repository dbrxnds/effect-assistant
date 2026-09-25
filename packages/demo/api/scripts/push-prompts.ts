/**
 * Uploads the prompts in code to Langfuse as new versions, labeled
 * `production` (or the label given), skipping ones whose text is unchanged.
 *
 *   pnpm --filter @acme/demo-api prompts:push [label]
 */
import { LangfuseClient } from "@langfuse/client"
import * as Prompts from "../src/Prompts.ts"

const label = process.argv[2] ?? "production"

const langfuse = new LangfuseClient()

for (const [name, text] of Object.entries(Prompts.defaults)) {
  const current = await langfuse.prompt
    .get(name, { label, cacheTtlSeconds: 0 })
    .then((prompt) => prompt.prompt)
    .catch(() => undefined)

  if (current === text) {
    console.log(`same     ${name} (${label})`)
    continue
  }

  const created = await langfuse.prompt.create({ name, prompt: text, labels: [label] })
  console.log(`pushed   ${name} v${created.version} (${label})`)
}
