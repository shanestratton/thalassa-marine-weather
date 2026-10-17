# Licensed lightning foundation

This source adds an authenticated Xweather adapter, a lazy Obs snapshot layer,
and the `lightning_nearby` push contract. It is held behind the exact public-beta
flag `VITE_LICENSED_LIGHTNING_ENABLED=false`. Blitzortung remains false.
No current subscription, redistribution permission, quote, live provider access
or operational notification worker is established by this source change.

The fixed upstream is `https://data.api.xweather.com/lightning/closest`.
Each explicit read requests the previous five minutes within37.04km (20NM),
with at most1000 rows and512KiB, a10-second deadline, and no pagination,
redirect, fallback or retry. A historical key does not admit the feed. Server
admission requires verified display and notification rights with an explicit
expiry. Do not log credential-bearing URLs or upstream error bodies.

Before every paid read, the existing service-only atomic quota RPC reserves a
shared UTC daily allowance and a shared minute allowance. Missing limits close
the service. `LIGHTNING_MAX_REQUESTS_DAY` must be1–2880 and
`LIGHTNING_MAX_REQUESTS_MINUTE`1–10; these are request reservations, not a claim
about provider billing units. Failed and interrupted reads retain their slots.
An independent real-user quota permits12 explicit reads per hour. Rights and
expiry are checked again after reservation and after the upstream await.

The parser preserves original second/millisecond clocks, cloud-to-ground versus
intracloud type and polarity. Missing, contradictory and unsupported originals
are refused. Old, future and out-of-radius events leave gaps. Capped results
are labelled. An empty response never means conditions are clear.

Opening the layer makes one query around the chart point at that moment. It
never pans the chart or starts a socket, polling, background work or automatic
retry. Account changes, Satellite Mode, backgrounding, expiry and unmount retire
the owned display. Credits use the existing rollup; the layer adds no page
furniture. The owner must toggle off and on for another explicit request.

`lightning_nearby` is an informational push type with original pulse time and a
short expiry. It does not override Focus or remain in the APNs backlog. Queue
entries older than60seconds and expired source events are refused. Tapping
opens Obs without starting a paid read. The pure decision requires fresh
original location and explicit consent; it emits no all-clear notice.

Still required before this roadmap package is complete:

- A current licensed quote and verified display/push rights, with bounded spend.
- An owner-scoped opt-in position/watch lease and atomic claim/enqueue worker,
  including revocation checks immediately before actual APNs delivery.
- Separate wx GOES GLM and MTG-LI optical-flash supplements, with original
  clocks, native product QA and explicit regional coverage. They must not
  impersonate network pulses or trigger the20NM ground-network push.
- Actual production admission, deployment/readback and final combined build
  validation. No provider request or purchase was made by this change.

Primary product and response schema:
[Xweather Lightning](https://www.xweather.com/docs/weather-api/endpoints/lightning).
Standard access documents a five-minute window and1000-result bound; a larger
history is a separate entitlement. No entitlement is inferred here.
