# Build 136: direct Signal K instrument reader

The Gateway page has a lazy **Signal K device setup** card. A user selects a
server origin and explicitly requests device access, approves it as read only
in that server's administration page, then checks approval. The app never
requests access automatically. Denied, revoked, expired and unsupported access
are visible states, with no retry/enrollment loop. A stable v4 client ID belongs
to the selected origin and account; approval hrefs cannot redirect to another
server or endpoint. This implements the standard v1 origin/endpoints, not every
vendor's custom proxy prefix.

The selected direct source starts lazily only without a paired Pi. Pairing,
account changes, source configuration changes, app background and Satellite
Mode retire it. A selected direct source blocks the legacy gateway auto-start;
manually connecting the gateway deselects the direct source. Repeated demand
for an already-reading identical direct session does not reconnect it. After
background/network failure, **Read Signal K** explicitly resumes. There is no
remote style, WAN fallback or browser WebSocket substitute.

Device approval tokens are bounded, origin/client/account scoped, stored in
the existing this-device-only Keychain plugin and excluded from Supabase auth
migration/purge keys. Preferences contain only origin, client ID, explicit
private-network HTTP choice and selection. No token is placed in a URL, browser
storage, displayed error or log. HTTPS uses system certificate validation.
Private-network HTTP requires an explicit choice and warns about cleartext
readings/token exposure. There is no certificate bypass, cookie credential,
redirect, generic URL request, arbitrary WebSocket send or direct write API.

The app-local Swift plugin supplies bounded, cancellable native JSON reads
(15 seconds, 64 KiB; 1 MiB for the self document) and receive-only WebSocket
subscriptions. Native WebSocket reception caps complete messages, including
continuations, at 64 KiB before bridging, with additional message/byte rate
bounds. Its sole POST is the explicit device access request. PUT/course/resource
and autopilot operations remain outside this reader. Native registration and
Keychain key allowlists match the frontend. No build number or entitlement changed.

Readings are explicitly `via: signalk`, `source: device`, labelled **Direct
Signal K · read only**. Original sensor clocks date both legacy gauges and
derived evidence. A current GPS/HTTP/receipt timestamp cannot revive a cached
heading, wind, RPM, depth or water-speed leaf; missing, null, expired and wrong-unit
values stay unavailable. SI conversions happen once. True heading is separate
from magnetic heading, leeway is optional measured signed input, and raw depth
is never relabelled as keel clearance. A negative declared keel depth is retained.
An aggregate positive RPM suppresses sailing; only an explicitly identified
single engine supplies the single-engine telemetry contract.

Qualified direct readings can produce the source-labelled read-only Current
panel. They do not qualify `isBoatFeed`, the navigation GPS chain, map own-ship,
followed-boat wind/model comparisons, current-corrected map laylines, phone-position
substitution, or the local instruments-silent alarm. Account/source retirement
clears the new lane's gauges and evidence synchronously. Existing Pi/gateway
readings and their authority stay intact; Pi LAN outranks direct and direct
outranks a cloud row while actively refreshed.

Notifications are separate memory-only source/path state (64 clocks, 160 display
characters, source issue time and age); null clears only the dated source/path.
They never enter bounded scalar telemetry. Sound defaults off for each session.
Opt-in plays a three-second cue only for a new source-dated sound-requesting
alarm/emergency, newer than this connection and at most ten seconds old. Replay,
duplicate, delayed import/acquisition, clear, account/source retirement and
background cannot create a new retained cue. The cue owns an AlarmAudioService
lease and releases only that lease; it never stops another alarm owner's audio.
Audibility depends on the app, system volume, route and Focus. This is not an
owner-away alert service.

Validation includes real store/lifecycle/protocol/native-bridge tests and the
existing source-policy/GPS/engine regressions. Actual Chrome/WebKit setup checks
at 300/375 px verify labels, reachable controls, honest authenticated-web refusal
and zero non-local requests or boat sockets; screenshots were inspected. Those
checks do not prove radio, Keychain, certificate, physical iPhone privacy or
actual boat-server compatibility. Release Mac compilation and a device approval,
read, revoke, background/resume test remain required before native readiness.

The independent Pi stream core is documented in `build136-signalk-read-stream.md`.
Its actual shared-reader/notification-route mount is a separate server integration
checkpoint; no Pi installation or backend deployment is included here.

Primary references reviewed 2026-10-16:

- https://signalk.org/specification/1.7.0/doc/access_requests.html
- https://signalk.org/specification/1.7.0/doc/security.html
- https://signalk.org/specification/1.7.0/doc/notifications.html
- https://developer.apple.com/documentation/foundation/urlsessionwebsockettask/maximummessagesize
- https://github.com/SignalK/signalk-server/security/advisories/GHSA-fq56-hvg6-wvm5

The server advisory identifies fixed access-request security in Signal K Server
2.19.0. The app never subscribes to server-event enumeration. Approval still
requires a secured, maintained server; this source change neither upgrades nor
claims to have inspected the user's installed Signal K version.

The existing in-memory telemetry history now clears synchronously on account
change and before a different feed/session, keeping its subscription alive.
Points use their original metric/qualified RPM clocks and are deduplicated,
with stale/null/unknown periods left as gaps. Legacy remote depth/voltage gauges
without a source clock remain visible but do not acquire invented history
samples; matching explicitly dated remote RPM can contribute. A quiet gateway
gap retains its already-valid earlier points until the normal window expires.
