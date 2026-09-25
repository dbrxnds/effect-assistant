# anti-slop

Source repository: https://github.com/dmmulroy/anti-slop

Source commit: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`

The files in this directory, except this note, are `skills/install-anti-slop/assets/anti-slop` from that commit. They match that tree byte for byte. The digest is SHA-256 over the sorted relative paths and file bytes, excluding this `UPSTREAM.md`: `6a5e9b6e859ea6668a06dd49fc158056c36617d50685a49ac2394ea9ab2be340`.

Installed entry points:

- `tools/oxlint/anti-slop/index.ts` registered as the `anti-slop` plugin
- `tools/oxlint/anti-slop/effect/index.ts` registered as the `anti-slop-effect` plugin

Dependencies installed together at the same version: `oxlint@1.85.0` and `@oxlint/plugins@1.85.0`.

## Local deviations

None in the vendored rule source. `oxlint.config.ts` enables every generic anti-slop rule, the native companion `oxc/no-accumulating-spread`, and the Effect rule group, because this workspace declares `effect` directly.

`anti-slop-effect/no-service-constructor-imports` covers relative project imports. Package and path-alias imports are outside that rule.

`vendor/eslint-stylistic/LICENSE` and `vendor/eslint-stylistic/UPSTREAM.md` travel with this copy. Do not drop them.
