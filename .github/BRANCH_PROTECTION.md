# Branch protection and checks

**This repository is private on GitHub Free (2026-10).** Branch protection rules and required status checks are not
available there; GitHub Pro restores them. Nothing stops a push to `master` that fails CI. CI reports afterwards, so read
it before building a release.

## What runs

| Workflow                     | When                                                                                             | What                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| **CI** (`check`)             | every push and pull request to `master`, except documentation-only                               | install and audit, release gates, lint, formatting, types, edge functions, production build and its checks, Lighthouse |
| **Full checks**              | nightly when `master` changed (unit tests); Sunday night (everything); **Run workflow** any time | unit tests with coverage, two-browser E2E against the built app, daylight/keyboard/split-pane and Plan Your Day suites |
| **Packages**                 | when `pi-cache/`, `workers/ais-ingest/` or `cloudflare-worker/` change; weekly                   | each package's own install, audit, build and tests                                                                     |
| **Hosted Deploy Smoke Test** | after each Vercel deployment of `master`                                                         | the deployed site, its ocean-data feeds and a browser smoke test                                                       |

## Habits that stand in for protection

- **Before a TestFlight upload, run Full checks** on the branch you will build and wait for green.
- Don't force-push `master`. A planned history rewrite is the exception; see `docs/GOING_PRIVATE.md` first.

## If you move to GitHub Pro

Protect `master`:

- require the `check` status check;
- block force pushes and deletion.

A pull request plus an approval doesn't fit a single-owner repository.

CodeQL was removed because code scanning on a private repository needs paid GitHub Code Security. Restore
`.github/workflows/codeql.yml` from history if that changes.
