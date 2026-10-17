# Anchor safe area: staged Pi 8 and relay contract

This source checkpoint follows the canonical foundation `506c8c455` and phone checkpoint `6d1c20ea3`. It completes the source path for a manually drawn boundary to be handed to a compatible paired Pi, recovered privately, checked by its GPS watch, and published through an owner-authorised relay. The additive canonical database change and JWT-preserving Edge version9 have since been deployed and read back; custom admission remains held pending version drain and compatible Pi installation. This source packet does not install Pi update8.

## Boundary and identity

The version-1 wire carries the exact anchor latitude/longitude, enclosing circle radius, canonical manual polygon or exclusion wedges, selected-vessel identifier, and a fresh owner-issued edit UUID. An explicit return to circle-only carries `zone: null` inside the same framed envelope; an unframed null cannot authorise a different anchor or radius. A missing envelope is the legacy circle protocol. No chart geometry is used.

The canonical parser and containment rule remain byte-identical in the phone, Pi and Edge mirrors. `node pi-cache/scripts/sync-anchor-zone.mjs --check` verifies them; the canonical SHA is `d3cf6297177587b7482600b5e5accb3003bd83a71eb3082e6ad66bb7902191f9`.

The phone captures account generation, selected-vessel revision and full pairing identity before asynchronous commands. A/B/A or replacement retires the command. Persisted keeper records include owner, selected vessel and pairing; recovered geometry and pending changes are revalidated. They are hidden and cannot renew or send commands from another context. The relay verifies the existing owner JWT, relay ownership, session ownership and session lifetime, then stores and echoes the boundary, selected vessel and edit UUID. The Pi echoes those values in its acknowledgement and subsequent reports. A missing, malformed, moved, resized, stale-UUID or different-vessel report is refused before heartbeat, realtime publication or alarm processing. Null vessel identity explicitly means no fleet vessel was selected; it is not evidence of a verified physical yacht association.

## Handoff and Pi admission

The phone requires both the relay's exact acknowledgement and the pinned Pi's version-1 capability plus exact acknowledgement before the page stops its local watch. Older Pi/Edge versions leave the phone watch armed. The phone does not claim to keep checking the custom boundary after a successful handoff: that path stops its local GPS watch. Until Pi update 8 is installed and verified, an existing Pi watches its circle only.

The capability reply includes an opaque boot/watch revision. New boundary commands present that revision. Pi admission requires an enrolled requesting device, the same live pairing, a fresh original boat fix inside the proposed area and enclosing circle, and no confirmed Pi drag alarm. It rereads enrollment, pairing, revision and alarm after the GPS read and checks them immediately before adoption. Exact unchanged renewals preserve their existing confirmation count/alarm and do not restart the watch. Durable recovery validates the full assignment before starting; the existing private atomic file mode and expiry rules remain.

Custom-area drag confirmation counts distinct original Signal K fix timestamps. Replaying one frozen outside position cannot accumulate confirmations. Missing or stale GPS retains the existing contact/GPS-lost path; reports still carry the exact authorised boundary metadata without fabricating a position. The native phone circle remains the backstop while that phone watch runs. The Watch companion still draws the shape and performs its existing circle-only local check.

## Explicit clear and move

The existing normal/alarm Move sheet contains **Clear area; keep circle watch**. Clearing never moves the mark or acknowledges a phone alarm. A replaced area retires a late clear result. A Pi clear requires a fresh Pi fix and no Pi alarm/GPS loss, and uses a new UUID with an exact framed circle. The first-centre rode-reach fence is retained. A custom shape is never translated with the mark.

An unconfirmed Pi clear remains visibly unknown. Renewal authorises the chosen circle and does not resend the old custom area. A report must match the selected vessel, exact frame, new UUID and a timestamp no earlier than the action before settling it. A known Pi admission refusal restores the prior authorised custom area, so its continuing reports remain acceptable. Moving a new-protocol circle similarly updates its owner-authorised frame before posting the move; a known refusal restores the prior relay boundary. Legacy circle moves retain their existing path and safeguards.

## Reviewed release sequence

1. Review the canonical migration, aligned to its actual applied ledger version at `supabase/migrations/20261017005140_anchor_safe_area.sql`, and [atomic backend review](anchor-safe-area-backend-review.md). The original future-dated held file remains preserved and must not also be applied. The canonical packet adds nullable bounded fields and service-only invoker operations; existing table RLS, client grants and the heartbeat implementation remain unchanged. The disposable PostgreSQL17.6 proof passed85 checks including five blocked competing transactions before deployment.
2. Deploy the staged `anchor-relay` source and shared canonical mirror, then verify owner/session/relay rejection, strict boundary echoes, stale UUID/frame/vessel rejection, no-fix status and existing expiry/alarm paths.
3. Include `anchorAreaAdmission.ts`, `anchorZoneContract.ts`, the canonical mirror and modified anchor server/broadcaster/store/command-lock modules in the reviewed Pi update 8 package. Stage only; no live installation is performed here.
4. After a separately authorised Pi installation, verify the capability, enrolled-device refusal, fresh GPS admission, distinct-fix drag, restart recovery, old-protocol compatibility and phone-to-Pi handoff on real hardware. Confirm exact boundary reports on Shore Watch before relying on the handoff. Existing safe circle watches remain supported.

Root owns whole-app TypeScript, configured production budget, composed browser acceptance, native Swift compilation and the final reviewed deployment/install decision. No physical iPhone/Watch/boat acceptance is claimed by this source checkpoint.

## Local evidence

The phone checkpoint records its separate 375-case focused and eight-case editor browser proof.

- The final transport/phone union has **461 passes / 25 suites**, covering canonical/parity, actual editing/recovery/context, real keeper and handoff, actual page handoff order, Move sheets, Shore alarm/reconnect/status, and existing backend/payload safeguards. Its log is `work/validation139-anchor-zone-freeze.log`.
- All **24 Chrome/WebKit cases pass**, 300/375 px, 130% text, keyboard up/down, in `work/anchor-zone139-transport-browser-final.log`. They include the actual editor and the Pi/alarm Move sheet clear path, 44 px reachable clear actions, no clear-induced move, and zero document growth. Screenshots are in `work/anchor-zone139-browser-results`; the 300 px WebKit clear view was inspected. The two initial Chromium keyboard measurements caught the sheet mid-transition; final tests wait for the existing keyboard band before measuring. The bounds, 30-second deadlines and action assertions were preserved.
- The Pi union has **78 passes / 81 cases**, including all eight new canonical admission, immutable recovery, identity/revision, distinct-fix and unchanged-alarm cases, in `work/validation139-anchor-zone-pi-freeze.log`. The unchanged Windows host cannot represent POSIX `0600`: the broadcaster-store and two command-lock file-mode assertions report `0666` on both the frozen pre-anchor checkout and this checkout. `work/validation139-anchor-zone-pi-mode-baseline-three.log` reproduces exactly those three failures before this feature. Those assertions remain intact and require the Linux release gate; they are not waived.
- Scoped lint has zero warnings/errors on supported source files, explicit Edge formatting passes, generated mirror `--check` passes, and `git diff --check` is clean. No whole-app compiler/build or native/physical acceptance was performed here.
