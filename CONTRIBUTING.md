# Contributing

Run `pnpm dev` and open `http://localhost:3000`. Without `DATABASE_URL` the API
keeps everything in memory, which is what local development and smoke tests
should use. Do not commit `.env.local`.

```bash
pnpm install
pnpm check        # typecheck + lint + format check
pnpm lint-fix     # oxlint --fix, then dprint
pnpm test
```

`pnpm start:node` starts the built demo. It listens on `0.0.0.0` and `PORT`.

## Code style

The code follows the Effect repo:

- **Formatting**: dprint with Effect's config (no semicolons, double quotes,
  no trailing commas, 120 columns).
- **Modules**: one concept per module, PascalCase file names, and
  `export * as Module from "./Module.ts"` barrels.
- **Layers** are module-level exports (`layerMemory`, `layerSql`).
- **Imports**: per module (`import * as Effect from "effect/Effect"`), never
  from the `effect` barrel, with `.ts` relative imports.
- **JSDoc** on every export, with `@category` and `@since`.

The lint rules (oxlint with the anti-slop plugins in `tools/oxlint`) enforce:

- `Predicate.isTagged` or `Match` instead of `_tag` comparisons;
- schema decoding instead of `typeof` checks and `JSON.parse(...) as X`;
- a `SAFETY:` comment on every type assertion.

## Effect LSP

`pnpm install` runs `effect-tsgo patch --typescript --no-oxlint`. That replaces the workspace TypeScript 7 binary with the Effect build. `tsc --version` reports `7.0.2+effect-tsgo`. `tsconfig.base.json` loads the `@effect/language-service` plugin. Point the editor at this workspace TypeScript so Effect diagnostics show up while editing. Docs: [Effect LSP](https://effect.website/docs/v4/getting-started/devtools#effect-lsp-effecttsgo).
