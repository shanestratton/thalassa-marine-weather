# Complete voyage archives — 25 September 2026

## Confirmed cause

The archive UI grouped the newest 10,000 rows returned by
`getArchivedEntries()` into voyages. A GPS-point limit is not a voyage limit:
it can truncate one voyage and omit older voyages entirely.

Read-only checks confirmed all five reported voyages were still archived in
the database, with **41,858 GPS points** in total. Newest-first counts were
820, 1,043, 5,691, 18,286 and 16,018. The old screen therefore stopped partway
through voyage four and never reached Newport → Callemondah. No recovery or
data mutation was necessary.

## Implementation

- Archive cards now use `getArchivedVoyageSummaries()`, with one complete
  aggregate per voyage. Both archived-inclusive and active-only RPC results
  are paginated; the list is no longer derived from a capped point window.
- Existing owner-scoped RPC aggregates preserve complete dates, point counts,
  distances, endpoints, departure time and explicit passage membership.
  Mixed archive-state, pending/local-only and legacy sentinel cases use
  complete lightweight detail reconciliation where necessary.
- Failed/incomplete reads are errors, not successful partial lists. The Log
  retains its last complete list and offers Refresh. Identity fences and
  request sequencing reject stale responses and old-account results.
- Accepted archive actions immediately transfer known summaries into the
  archive view. Restore removes accepted rows immediately, reports partial
  completion honestly, and leaves failed rows archived. Accepted restores
  immediately seed the Log summary, retaining it through stale/offline reads
  until the service confirms it; deletion and re-archive intents still win.
- The archive shows origin → destination, departure date, distance and
  non-rounded-up duration. Passage legs retain their purple group, with
  individual Restore and confirmed Restore passage controls. Counts refer to
  voyages, not visual groups. Empty/loading/error states are explicit.

The actual authenticated RPC was checked read-only and returned five archived
voyages totaling 41,858 points; the three passage legs retained the same passage
group ID. No customer records were deleted, restored, re-archived or renamed.

## Regression coverage

Focused tests cover five voyages exceeding 10,000 points, aggregate pagination
beyond 1,000 voyages and smaller server page limits, complete fallback reads,
failed pages, local archive/unarchive intent, queued acknowledgements,
account changes, stale refreshes, partial restores and passage membership.
Component/mobile layout checks cover counts, endpoint labels, passage grouping,
progress, retry and restoration controls.
