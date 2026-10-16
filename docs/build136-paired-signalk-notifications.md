# Build 136: paired Pi Signal K notifications

The lazy Signal K setup card uses `PairedPiSignalKCard` when a Pi is paired. Its
explicit reader calls only `GET /api/signalk/notifications` through
`pinnedPiRequest`, after confirming native pin support, a current enrolled device
and the currently reachable boat-LAN base. There is no remote-access, browser,
direct Signal K or weather-provider fallback. It is usable in Satellite Mode
because the Pi endpoint is cache-only and the transport remains local.

`PairedPiNotifications` retains only the current account/feed's bounded in-memory
notices. It checks the account generation, exact Pi key/device/pairing time and
live LAN base before and after every asynchronous operation. A one-second guard
retires changed pairing/transport state between polls. App background and document
visibility retirement clear notices and audio immediately; foreground does not
automatically restart. The sequential poll runs every three seconds after a read,
with a seven-second overall deadline and no overlapping retry after failure.

The schema-1 response is rejected above 16 KiB UTF-8, before JSON parsing. Strict
session/source/path/clock/message/range checks preserve source timestamps and
source/path IDs. A stale response, malformed/legacy schema, enrollment refusal or
old Pi clears the reader with an honest state. No body, credential or URL is logged.
The native bridge has received the bounded server response before the JavaScript
size check; this is not a new preallocation limit on the shared native Pi plugin.

The shared notification display shows **Paired Pi**, original UTC date/time, age,
source and notification path. The direct phone reader uses the same display with
its own source label. No scalar telemetry, navigation source, route/course write,
chart permission or owner-away alarm capability is added.

Sound is off on start. An explicit opt-in permits a three-second foreground cue
using `SignalKNotificationAudio`'s owned audio lease. The initial notification list
and each new Pi source session are silent baselines. Replayed source clocks are
deduplicated even across a temporarily absent notice. A truncated list disables
cues and says why; account/source/background/session retirement releases only this
reader's lease. Existing alarm owners keep their audio.

Validation includes parser/lifecycle/late-response/source-retirement and replay
regressions, plus the existing direct reader and owned audio tests. Actual Chrome
and WebKit checks at 300/375 px verify the controls, source-clock/path display,
130% text, footer clearance and zero external requests/sockets. The paired-browser
fixture is explicitly fictional and proves browser refusal and layout; it does
not simulate a physical pinned native connection. Physical Pi/iOS validation and
installation remain release work.
