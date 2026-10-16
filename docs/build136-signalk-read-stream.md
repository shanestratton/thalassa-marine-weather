# Build 136: read-only Signal K stream core

Source only; not installed on the Pi. `startSignalKReadStream` accepts the operator's fixed
origin, optional server-owned `SIGNALK_ACCESS_TOKEN`, and a verified self URN. It returns
only `stop()`: there is no arbitrary send, PUT, resource or course API. The separate
`THALASSA_SIGNALK_COURSE_WRITES` opt-in belongs to the course writer and is not changed here.

The stream uses `/signalk/v1/stream?subscribe=none`, a Bearer **header**, self-vessel context,
the fixed instrument paths, at most eight identified propulsion records, and notifications.
No token is put in a URL. TLS uses normal certificate verification. Plain HTTP requires the
same explicit private-LAN exception as the reviewed HTTP client; loopback remains allowed.
No discovered alternate host is followed. An Undici **Client** dispatcher applies the
64 KiB/32-fragment WebSocket receiver limit (the default is far larger). A second application
limit permits at most 64 messages / 256 KiB each second. Opening has a ten-second deadline;
thirty seconds without a message disconnects. The owner decides whether/when to reconnect.

`SignalKReadState` is a portable, bounded self-vessel cache, with no Node/network dependency.
Delta update timestamps date only that update's leaves. REST bootstrap accepts exact leaf
envelopes with their own timestamps, explicit matching self UUID and matching declared units;
parent/GPS/receipt timestamps never substitute. Invalid, future, repeated or older readings
cannot replace newer ones. Null remains a dated null. Consumers must still apply each
sensor's freshness gate: a live connection does not make every cached leaf live.

Notifications stay separate from scalar telemetry. There are at most 64 source/path clocks,
including clear tombstones, and 160 display characters per active message. A source-dated
null clears only that source/path; an older clear cannot erase a newer alert. The first
event on each path is treated as an initial snapshot, so it is never marked for a siren.
Only a later unique, source-dated event within ten seconds can have `fresh:true`; this is
eligibility, not permission to play sound. UI opt-in, foreground/account/session fences and
an owned alarm-audio lease remain required. There is no audio or background notification
claim in this core. Restart/reconnect creates a new cache and suppresses initial replay.

`onDocument` provides a source-clock-preserving self document for the existing measured
readers; `onNotifications(active, events)` is a separate memory-only view. `onState` reports
connecting/reading/disconnected/stopped, not navigation or write permission. A callback
failure closes the stream. Stop clears notification state and destroys its dispatcher.
The server integration must retain the paired/app API gates and keep subscriptions private.

Validation: seven portable protocol tests; three real local HTTP-upgrade/WebSocket tests
cover header authentication with no query credential, timestamp preservation, receiver
oversize rejection, and no credential forwarding through a two-server redirect. Pi TypeScript
passes. No boat server capability, physical phone operation or live deployment was probed.

Primary references (reviewed 2026-10-16):

- https://signalk.org/specification/1.7.0/doc/security.html
- https://signalk.org/specification/1.7.0/doc/subscription_protocol.html
- https://signalk.org/specification/1.7.0/doc/notifications.html
- https://signalk.org/specification/1.7.0/doc/access_requests.html

The direct-phone source will use the same portable protocol, device-approved secure token,
explicit `via: signalk` / `source: device` identity and source label. It does not acquire Pi
LAN/local-navigation privileges; read-only Current calculations may use qualified original
clocks, true heading, STW and explicit signed leeway. No phone-position substitution.
