# Build 111 preparation — GPS transitions and OBS investigation

Build 110 was uploaded on 10 September 2026 and remains immutable. These
changes are the next native candidate, 1.2.0 (111), not a replacement 110.
No 111 archive or TestFlight upload is claimed here.

## Fixed: phone error during vessel selection

Selecting a receiver previously published `unavailable` before the read had
completed. The target-change listener also immediately created an error, and
the old phone error could survive while the new boat lookup was pending.

The transition now publishes `resolving`, clears the outgoing error and
forecast, and displays “Finding boat location…” or “Finding phone location…”.
The position row is neutral while resolving. Actual failed reads still become
unavailable; source, identity and selection-epoch checks are unchanged.

Three new regressions failed before the correction. Seven relevant suites
then passed all 148 tests; scoped lint and formatting passed.

## Fixed: unintended ENC prewarm work

The OBS map previously started its boot chart merge regardless of the ENC
switch, including in lightweight pickers and after a deferred import outlived
the map. This made switching ENC off an unreliable diagnostic isolation step.

Boot prewarm now checks the live ENC/plotting intent and map lifetime. Normal
visible-chart loading and plotting remain enabled. No memory limits were
changed and no chart records were deleted. A merge already admitted may be
shared with the ordinary renderer and is not cancelled by this narrow fix.

## Open: Town Common → OBS restart

The user's reported restart has **not yet been reproduced or attributed**.
Map/ENC errors are normally handled locally. Installed Capacitor reloads its
web view after WebContent termination; the separate `lazyRetry` path can also
reload after a lazy-module rejection. Either can return to the normal Glass
boot page. Source inspection alone does not establish which occurred here.

The phone was detected but targeted diagnostic reads were blocked because it
was locked. No phone crash logs or local-storage diagnostics were obtained.
The flight recorder and census remain in code, but their former “Last Flight”
card was removed in build 105; it is not available for a screenshot in 110.

After unlocking, collect the relevant WebKit/Jetsam report and, if permitted,
only Thalassa's diagnostic storage keys. Preserve the distinction between an
unclean exit and a proven memory-limit termination. Reproduce named Town
Common → OBS with the same installed chart inventory before claiming closure.
