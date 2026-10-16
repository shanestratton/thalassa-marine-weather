# 139-09: browsing notices and NOAA revision metadata

## Obs source behavior

Obs shows public warning anchors only within the current camera from zoom 9,
default on, with a switch in Charts & detail. It does not change the existing
plotting notice/bridge hook or routing geometry. Marker work is capped at 40;
candidate bounds are 5,000 broadcast notices, 1,000 cached Queensland entries,
500 bundled advisories and 64 text coordinates per broadcast notice. Dateline
camera copies are handled locally; no viewport or vessel coordinates are sent
to an issuer.

Available broadcasts come from the existing fixed NGA, AMSA, UKHO and LINZ
transports. Each response is limited to 1 MiB, 2,500 records and 15 seconds.
Partial failure preserves that source's old warnings and original check clock.
Legacy merged cache receipt times do not become measured source check times.
Satellite Mode stops discretionary refresh without rewriting freshness. Obs
reads Queensland's existing cache and does not launch its 28-dataset fetch.

Popups keep original issue strings and separate source check ages. Text is
inserted as text, with a safe source link, incomplete-coverage disclosure and
an explicit distinction between a text coordinate/approximate locality and a
warning boundary. No icon means no completeness claim. The visible marker
stays 28 px, with a 44 px button. Popup content scrolls inside the map's height;
its close target is 44 px. The initial title is not scrolled away by Mapbox's
automatic focus of a source link. Dark and daylight text use app tokens.

## Metadata-only NOAA contract

New publisher generations include an optional, generation-owned
`revisions.json`: at most 1 MiB and 10,000 complete active-cell records containing
only ID, integer edition/update and original issue/base-issue dates. The root
pins its path, exact bytes and SHA256. The publisher verifies its generation,
complete coverage and equality with the regional catalogue before any cloud
write, then reads it back before publishing the root with existing CAS.
Existing manifests without this object remain valid and explicitly incomplete.
No chart geometry, titles, account details or coordinates enter this object.

The Pi checker uses two fixed public metadata requests, at most 1.25 MiB total
and 30 seconds. Both original source and check clocks must be within eight
days; a fresh check cannot renew an old source. It rejects rollback, future or
invalid clocks, partial/ambiguous cohorts, invalid dates and hash mismatch.
Unknown installed updates remain unknown. Only open US NOAA installed metadata
is compared; protected/vendor geometry and blobs are never read.

State is scoped to current owner, Pi, pairing and configuration-revision UUIDs.
Owner changes, stopping, policy loss and expiry fence awaited work. Successful
checks wait a day; failures wait an hour. Summaries contain at most eight
changes and a truthful `more` flag, with no more than two accepted receipts per
UTC day. Up to 10,000 revision identities are retained; capacity refuses before
calling a sender rather than evicting old dedupe evidence. A `true` callback
means the future transport accepted the summary, not that APNs delivered it.

## Pi update 8 / deployment packet: held

This commit does not mount the checker in `pi-cache/src/server.ts`, deploy a
chart-edition sender, publish a new NOAA generation, start a timer, send a
notification or install on a Pi. The current published generation
`bf4f88ed8df53ee07d2d01ee` has no revisions object and therefore cannot produce
a complete new-edition check. The following integration remains required before
activation:

1. Create the checker only inside the existing enabled, paired app-server
   boundary. Read owner/Pi/pairing truth from server-owned configuration, and
   introduce an explicit opt-in configuration revision UUID that changes with
   ownership, pairing or consent. Never accept those identities from notice
   JSON or query parameters. Call `stop()` when retiring this lifetime.
2. Supply the reviewed existing installed ENC index directory to
   `installedNoaaEditions`; put `NoaaEditionFileState` under the existing
   `CACHE_DIR`. Use the existing current internet permission, not a caller's
   boolean. A small bounded scheduler may invoke `tick()`; the checker enforces
   cadence, budget and one active request. Report incomplete/held states.
3. Implement and review the paired-Pi `chart-edition` receiver and personal
   owner-only push type. Verify current owner/pairing/configuration revision,
   current phone registration and ordinary-notice opt-in on the server before
   queueing. Preserve idempotent per-cell revision receipts and bounded quotas.
   No shore contacts, rescue addresses, critical alarm entitlement, location
   disclosure or automatic chart replacement belongs to this lane.
4. Advertise support only after the receiver is actually deployed and verified.
   Supply the notify adapter only then; no sender means delivery held. Publish
   a separately reviewed NOAA generation with the exact optional revisions
   object before claiming a complete check. Existing publication ownership,
   immutable-object verification, CAS and storage caps still apply.
5. Package these source/mirror files in Pi update 8 with the other 139/140 boat
   parts. Stage and validate the exact released source; physical installation
   and hardware acceptance remain separate. No unattended install during watch.

Pure metadata mirrors are generated by
`pi-cache/scripts/sync-noaa-edition-policy.mjs`; its `--check` mode verifies
content and source digest. It copies no app auth, Preferences or geometry code.
The exact compact public NOAA wire fixture uses `.json.txt` plus `-text` in
Git attributes, so neither JSON formatting nor host line endings alter its hash.

## Verification

Task-local logs are under `work/validation13909-*`. The final source passed
62 focused cases in nine suites, 15 Python publisher cases, nine Pi checker
cases and four real Chrome/WebKit cases. The browser matrix covers 300/375 px at
130% text, source issue/check clocks, dateline camera filtering, safe text,
dark/daylight popup geometry, the actual Charts toggle, owner/foreground
retirement and unchanged document extent. Synthetic Mapbox session/telemetry
responses are answered locally; no provider request leaves these tests.

Initial browser evidence is retained: it exposed Mapbox's custom-marker
`role=img` override, then fixture-only absolute-position/blob-routing issues.
Visual review also found source-link auto-focus scrolling away the popup title;
the source fix preserves the title and focuses Close without scrolling. The
final proof receipt records the final rerun. Whole-app TypeScript is recorded
separately for the frozen source; TypeScript and bundle measurement remain
required on the composed 139 release source.
