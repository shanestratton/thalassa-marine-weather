# Sightings online and offline browser isolation

The online scenario now explicitly unmounts its final map, verifies that
`map.remove()` ran, and checks its page-error collector after teardown. The
offline scenario uses a separate Page and keeps every existing source-free
map, dateline, pixel, marker, private-coordinate, selection and zero-page-error
assertion. The online collector is checked again after the offline scenario.
No product code or error filtering changes.

Historical run `38958694977`, definition
`fcf3c152686ee00676ae952bc245261cf1addd0e`, had four blob access-control
page errors at the final WebKit 375 px assertion; the retry passed. All
functional offline assertions passed before that error assertion. The helper
previously installed the new collector before navigating away from an online
map that was still mounted. Outgoing document/blob timing is plausible, but the
cause of those errors remains unproven.

Before this change the original test passed 12 instrumented, unchanged WebKit
repeats on source with identical relevant files. The diagnostic records one SDK
worker blob per document, shared by its pool. Four distinct error IDs do not by
themselves prove a worker defect. The artifact retains only the successful retry
trace, not a trace of the initial failure. This change improves deterministic
test isolation and does not claim to fix a demonstrated product defect.

The isolated sequence passed all four 300/375 px Chrome/WebKit cases, then eight
additional WebKit 375 px repeats, with no retries or filtered errors. An AST
comparison of the original offline block preserves its full logic and all
literal text, changing only the Page identifier.

Retained task-local evidence:

- `work/validation137-first-job-117167968525.log`: original failure and retry.
- `work/validation137-sightings-lifetime-diagnostic-second.log`: 12 original
  WebKit repeats, with unfiltered errors and document/blob/worker lifetimes.
- `outputs/Build137 Sightings browser diagnostic.json`: diagnostic limits.
- `work/validation137-sightings-isolation-four.log` and
  `work/validation137-sightings-isolation-eight.log`: isolated sequence checks.
- `work/sightings137-offline-assertions.json`: original offline AST comparison.
- `work/sightings137-ci-trace/keyboard-3.zip`: artifact `12074461613`, 176,979,229
  bytes, SHA256
  `2b50a86aa5da34e5cc5ee05d96ff03d12bba95df0b16105ea588c35696ea969a`.
  Its metadata and download were capped at 192 MiB; only the relevant small
  screenshots, error context and retry trace were extracted.
