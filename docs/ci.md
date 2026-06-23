# CI and the PR merge gate

Every pull request to `main` must pass the `verify` check before it can merge,
alongside one approving review. The check is the GitHub Actions workflow at
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml), which runs a single
`verify` job on `ubuntu-latest` with Node from `.nvmrc`.

## What `verify` runs

The job runs the full hermetic check suite, ordered fast→slow so cheap failures
surface first. A failed step fails the job (and blocks the merge):

1. `npm run format:check` — Prettier
2. `npm run lint` — ESLint
3. `npm run typecheck` — `tsc --noEmit`
4. `npm test` — Vitest
5. `npm run build` — esbuild bundle

## Run the checks locally

```sh
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

`npm run format` (Prettier `--write`) fixes formatting failures in place.

## Surface integration tests are opt-in

CI is hermetic: it sets no `RELAY_*_INTEGRATION` env var and installs no
browsers, so the surface / Playwright integration tests stay **skipped**. They
are not part of the merge gate. To run them locally, set the relevant
`RELAY_*_INTEGRATION` variable (and install Playwright browsers) before
`npm test`.

## What gates a merge

The `main` branch ruleset requires, for any PR into `main`:

- the `verify` status check passing, and
- one approving review.

Repository admins retain bypass, so an admin can still merge in an emergency.
