# Changesets

Every change to `effect-assistant` that users should know about adds a changeset:

```bash
pnpm changeset
```

Pick the bump (patch, minor, major) and describe the change. On `main`, the release workflow opens a
"Version packages" PR that applies the pending changesets; merging it publishes to npm.
