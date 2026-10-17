# Persistent map credits Close

ObsCreditsRollup now supplies a44px Close footer through the existing
ModalSheet.footer port. Provider links/status remain inside the current scroll
body. The shared modal, its viewport cap,44px rollup strip, map attribution and
source/safety text are unchanged.

Actual Chrome and WebKit source proof passed6cases at300/375/430px,130% font,
667px viewport. After scrolling to the final source link, the footer rectangle
stays fixed, fully on screen and hit-test reachable. Document and actual
Mapbox canvas/frame extents remain byte-for-byte equal before/after opening and
closing. The12unchanged137map/credits cases also passed in the same54case run.

Proof: work/validation141-evidence-final-phones.log and its corresponding
evidence141-final-browser/obs-credits141-footer-\* screenshots. The spec is
browser-tests/obs-credits141-footer.spec.ts and uses the existing synthetic
local-map fixture. No AU/NZ regional layer or provider acceptance is asserted
by this isolated proof. No provider calls, live account or native phone was used.
