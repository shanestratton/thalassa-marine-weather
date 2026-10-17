# Build 136: shared Pi Signal K read session

`SignalKReadSession` owns one operator-configured, authenticated read-only source.
It bootstraps the exact vessel UUID over the fixed, bounded self endpoint, then
receives allowlisted WebSocket deltas with their original source clocks. The full
1 MiB bounded REST document remains available to existing instrument and Systems
readers; validated delta leaves overlay it only when at least as new. A newer
source-dated null survives a delayed REST refresh. Self refresh is every 30 seconds;
the separate existing AIS vessels collection is refreshed every five seconds,
bounded to 4 MiB. Shared-reader calls by phones and the AIS watch are cache-only.
The additive `BroadcastDeps.selfDocument` callback supplies that same authenticated
cache to the track recorder, anchor readers, wind history and telemetry publisher.

The self subscription also carries magnetic COG, GNSS time/quality/satellites/HDOP
and up to eight battery voltage instances. These retain original envelopes and SI
units. Unknown fields are not guessed. Existing telemetry packing and its scalar
budget are unchanged. Notifications never enter scalar telemetry.

Socket retirement immediately clears self, AIS and notifications. A reconnect
bootstraps identity again and gets a new random notification session. Old replies
and callbacks cannot enter a later lifecycle; retries are paced up to 30 seconds.
The optional `SharedSignalkReader` callback bypasses its legacy REST TTL, so it
cannot retain a retired stream for another 1.5 seconds. Legacy constructors retain
their previous REST behavior.

## Server integration (root-owned server and lock table)

Required source files for the stage-six updater: `signalKClient.ts`,
`signalkProtocol.ts`, `signalKReadStream.ts`, `signalKReadSession.ts`,
`lanTelemetry.ts`, `anchorBroadcaster.ts`, `telemetryPublisher.ts`, and
`routes/signalKRead.ts`. Keep the existing pinned `undici`
dependency and lockfile. No native version or live installation is included.

```ts
import { SignalKReadSession } from './signalKReadSession.js';
import { createSignalKReadRoutes } from './routes/signalKRead.js';

const signalkRead = new SignalKReadSession({
    origin: SIGNALK_ORIGIN,
    accessToken: process.env.SIGNALK_ACCESS_TOKEN,
    // Reuse the operator's explicit private-HTTP choice, if supported by config.
    allowInsecureLan: process.env.THALASSA_SIGNALK_ALLOW_HTTP_LAN === '1',
});
void signalkRead.start();
const signalkDocuments = new SharedSignalkReader({ fetchImpl: fetch, signalkOrigin: SIGNALK_ORIGIN }, 1500, () =>
    signalkRead.readDocuments(),
);
const selfDocument = async () => (await signalkRead.readDocuments()).selfDoc;
// Include selfDocument in EVERY server-created BroadcastDeps literal, and in
// WindHistory, TrackRecorderRunner, AnchorWatchRunner and TelemetryPublisher deps.
app.use('/api/signalk', requireAppApi, createSignalKReadRoutes(signalkRead, chartDevices));
// Add signalkRead.stop() to the existing shutdown path.
```

Register exactly `GET /api/signalk/notifications` as a read in `piCommandLock`.
The route independently requires a currently enrolled chart-device credential,
including in observe mode. It accepts no query parameters, writes or configuration.
It is `no-store`, has schema 1, a random session ID, source/receipt clocks and a
16 KiB UTF-8 response ceiling with explicit `truncated`. It exposes neither the
server token/origin nor vessel UUID. Route reads trigger no upstream operation.

The cache callback returns null during bootstrap or retirement. `fetchSelfDocument`
does not downgrade to discovery/REST when the callback returns null or throws, and
checks cancellation/current-source fences before and after it. WindHistory already
preserves this optional dependency through its existing spread; TelemetryPublisher
now forwards it explicitly. Legacy callers without the callback retain their prior
REST behavior. The publisher also retains its prior last-bus behavior, preserving
that earlier bus's original clocks rather than dating stale values as fresh. Its
existing cloud internet/pairing policy is unchanged.

`SIGNALK_ORIGIN` and `SIGNALK_ACCESS_TOKEN` are shared operator-owned settings;
absence of a token permits only whatever anonymous reads that server supports.
HTTP outside loopback needs the explicit private-LAN opt-in and remains insecure.
This read session grants no course, chart, autopilot or owner-away alarm authority.

The composed server now mounts that exact enrolled read route, injects the
cache-only reader and stops the session during shutdown. Session setup precedes
starting the track, history, telemetry publisher and anchor readers; their self
reads and the server's current-fix paths use the same cache-only callback. Both the reader and
separately enabled course client use the same explicit private-HTTP choice;
loopback remains supported. A rejected operator configuration leaves instrument
documents unknown and emits a generic message while the watch service continues.
It never silently falls back to the legacy unauthenticated transport.

## Proof and limits

Focused tests exercise actual authenticated REST plus WebSocket data through the
shared reader, original clocks, preserved legacy fields, null clearing after an
older refresh, identity changes, stop/restart races, delayed callbacks, paced
failure recovery, cache-only reads and bounded notification payloads. An actual
HTTP router test proves app-gate/enrollment/removed-device/error refusal before
reading notices and refuses write methods. Existing HTTP redirect/byte/time and
actual WebSocket payload/redirect tests remain required.

Checkpoint checks: 54 Node tests (session/router/client/stream and existing
AIS/track readers), eight portable protocol tests, Pi TypeScript and scoped ESLint
passed. The final combined app/native checks remain with release integration.

The follow-up shared-self-source seam adds five passing regressions for anchor,
publisher, track and wind consumers, including no REST downgrade, original clocks,
cancellation/source retirement and repeated-reading deduplication. The 99-case
combined local run passed 97; its unchanged POSIX file-mode assertion and symlink
creation test cannot pass on this Windows filesystem. Pi TypeScript and scoped
lint pass; Linux keeps both security assertions. Initialize the read session
before starting any reader whose callback closes over it, and wire every server
dependency literal, not only the named constructors.

The installation, approved Signal K token, physical Pi and phone LAN transport
still require release/device validation. Tests use loopback fictional fixtures.
There is no live server or provider mutation in this checkpoint.

Primary field references: [navigation schema](https://raw.githubusercontent.com/SignalK/specification/master/schemas/groups/navigation.json),
[electrical schema](https://raw.githubusercontent.com/SignalK/specification/master/schemas/groups/electrical.json),
[subscription protocol](https://signalk.org/specification/1.7.0/doc/subscription_protocol.html),
and [notifications](https://signalk.org/specification/1.7.0/doc/notifications.html).
