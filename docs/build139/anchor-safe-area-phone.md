# Anchor safe area: phone, Shore Watch and Watch companion

This source checkpoint builds on the canonical geometry rule in `506c8c455`. It adds an explicit manual editor, phone alarm adoption and recovery, Shore Watch drawing, and bounded drawing on the compiled Watch target. Pi assignment/relay storage and the held database contract follow as a separate source checkpoint; this is not complete build 139-06 release acceptance.

The later [staged transport checkpoint](anchor-safe-area-transport.md) adds compatible Pi handoff and the held relay contract. The circle-only Pi limitation described below records this phone checkpoint's state; the later source requires an exact new-protocol acknowledgement before handoff.

## Manual boundary and recovery

The existing anchor radar has an **Area** control. The lazy sheet supports finger/tap polygon corners and up to eight true-bearing exclusion wedges. All geometry goes through the canonical parser; no chart data is read or copied. The explicit **Use area** action requires a recent boat fix inside the proposed area. **Circle only** explicitly removes a custom boundary. The circle remains the native backstop.

The service serializes edits with its existing safety queue. An editor captures the exact watch/anchor/radius/area revision plus account generation and vessel-change revision; account/vessel A/B/A and competing successful edits retire it. A write is persisted before the new area becomes observable through snapshots or broadcasts. A failed or context-retired edit restores the former area through the existing serialized recovery adapter; if rollback cannot be saved, verification is blocked. The old native circle is never removed by an area edit.

Recovery validates the saved custom area against the saved anchor and computed circle before GPS or native arming. A corrupt, unsupported or mismatched saved area remains visibly blocked, rather than silently falling back to a green circle. Valid old records without an area remain compatible. Stop/failed setup clears the in-memory area.

The software drag counter applies the shared area rule to accepted filtered GPS positions, and custom-area confirmation requires distinct original fix timestamps. Re-reading a frozen outlier cannot accumulate confirmations. The existing GPS source/admission watchdog and independent native circle EXIT path remain active. A shape cannot be translated automatically by moving the anchor or silently clipped by shrinking the circle. Normal and alarm Move sheets provide an explicit clear-area action; clearing never acknowledges an alarm, and moving still goes through the existing authority and rollback.

## Coverage truth and companion drawing

This phone checks the custom boundary when GPS updates reach its software watch. If iOS suspends it, the native circle remains the backstop. The editor says so. Current circle-only Pi handoff is refused while a custom area is active: handoff stops the local phone watch, so claiming the phone continues to watch the area would be false. The skipper can explicitly return to the circle before that handoff.

Shore Watch receives only validated geometry from a publisher explicitly naming phone/Pi area monitoring. Its existing stale/contact watchdog remains authoritative; a fresh outside-area sample says **Outside safe area · checking** until the publisher confirms its alarm. The canvas draws the boundary and shades excluded water. Last-known geometry remains labelled as such.

The Watch payload carries only normalized, bounded display points or wedge angles, not another alarm implementation. The compiled Watch model bounds these arrays; its view draws them and says **PHONE AREA · WATCH CIRCLE CHECK ONLY**. Its existing timestamp/reachability/foreground companion rules and circle-only local warning remain unchanged. The uncompiled historical Watch prototype is untouched. Native Swift compilation is still a Mac release gate.

## Evidence and limits

- **375 cases / 14 focused suites pass** in `work/validation139-anchor-zone-fourth.log`: canonical/parity, real service editing and recovery, deferred writes and auth retirement, real context A/B/A, distinct-fix drag, unchanged geofence/move/secure storage/watchdog behavior, Shore Watch and actual page/sheet components.
- Final vector-close-control/canvas UI changes: **149 cases / six relevant suites pass**, `work/validation139-anchor-zone-ui-final.log`.
- **Eight Chrome/WebKit cases pass**, 300/375 px at 130%, keyboard up/down. The actual editor, focus trap and CSS use synthetic action adapters; no real account, watch, provider or boat action occurs. Tests assert an entirely reachable drawing/field, 44 px controls, pinned actions above the tab/keyboard band, and zero document growth. Final log `work/anchor-zone139-browser-final.log`; screenshots `work/anchor-zone139-browser-results`. The 300 px WebKit image was inspected after replacing the font-glyph close control with the existing vector icon.
- The first cold browser harness timed out at its unchanged 30-second load deadline because it imported the entire watch service graph. The sheet now takes its normal action callbacks from the page; the isolated browser fixture supplies synthetic callbacks and imports no watch service. The complete service/controller behavior is covered separately. No deadline or layout assertion was relaxed.
- Scoped lint has zero errors; the Playwright config is ignored by the existing lint configuration. Canonical phone/Pi/Edge mirror SHA remains `508b4bfd348d4e34d3ccaea7ec0aaf1d9364d5a3e89d65c4a4075c906ee94a9f`; sync `--check` passes.
- This does not claim whole-app TypeScript, configured production budget, full-page composed browser acceptance, Swift compilation, physical iPhone/Watch/boat acceptance, Pi installation, database push or Edge deployment. Root owns those gates and the reviewed release sequence.
