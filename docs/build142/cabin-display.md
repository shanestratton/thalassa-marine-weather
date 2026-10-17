# Read-only cabin display

The separately built page reuses the public heading and barometer gauges and
shows speed, true wind and depth from the Pi's existing shared telemetry reader.
It is not imported by the phone graph. The new HTTP listener defaults off,
inherits the explicitly selected Pi LAN bind, and permits actual boat-LAN peers
and loopback only. It mounts no main app, enrolment, proxy, configuration, watch,
arm, silence, acknowledgement or stand-down route. A cabin credential confers
no main API authority; the existing main API LAN and command-lock policies
remain independently enforced. The dedicated cabin header is explicitly
refused there, without affecting unrelated headers or enrolled app clients.
Invalid optional display-port configuration refuses this listener without
interrupting the main Pi/watch server. Authenticated telemetry allows one
pending read per viewer, at least500ms between reads and at most eight total
pending reads; its request-budget map is capped at16 entries. These are separate
from the existing shared Signal K reader and its original source clocks.

The local operator command `node dist/cabin/accessCode.js --rotate` prints a
new eight-digit code once. Only its hash, random generation nonce and ten-minute
expiry enter a bounded private code file. Browser pairing mints a separate
256-bit viewer bearer, kept in page memory only. There are at most eight
sessions, each with an unrenewed twelve-hour lifetime; fixed global/per-peer
attempt limits bound guessing. Rotation, missing/corrupt code, source authority
changes, closure or clock reversal retire leases. A process-local generation
in the existing outbox changes on actual owner/relay/token/internet-policy
transitions, including A→B→A between awaits. Repeating unchanged configuration
does not retire viewers. No token or code enters a URL, HTTP/server log or command credential.

The original report clock is retained. Old, future, absent or malformed readings
become unknown, with byte-capped responses and reads that retire after a deadline,
tab hiding, source change or closure. A delayed old read cannot restore data after
retirement. The page has day/night presentation only, with no watch actions.

Collision alarms and the Pi phone-alert relay state come from the existing
build126 `aisWatch.describe()` mirror; this page computes no alarm. Stale watch
passes are labelled old, and retained alarms stay labelled last reported rather
than becoming a new clear state. The existing anchor runner exposes running and
dragging state but no original sample clock: the page can show a reported drag,
explicitly with sample time unavailable. It makes no known-clear anchor claim.
Other watch families are not claimed as covered by this reader.

The ten final local Node/real-HTTP cabin tests and five real-React/stream tests
pass. They include command/enrolment absence, main API credential separation,
expiry, rotation, owner retirement after an await, stale original clocks, hidden
tab late-response refusal and cancellation of a never-resolving read. Pi-only
TypeScript and the separate three-file page build passed during development;
exact final browser/artifact proof follows the frozen source checkpoint.

The inherited command-lock suite passed30/32 tests on Windows; both remaining
assertions require POSIX0600 and observed Windows0666. Those original assertions
are unchanged and their failure log is retained. Windows has no installed native
SQLite binding, so the new real-outbox generation regression deliberately has no
skip: it requires the isolated Linux Node22 proof, as do permission/install tests.
No local SQLite, full phone build, live Pi installation, listener activation or
actual device alarm acceptance is inferred from these source tests.
