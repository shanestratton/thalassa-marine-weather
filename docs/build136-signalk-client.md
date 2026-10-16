# Build 136: bounded Pi Signal K client

`pi-cache/src/signalKClient.ts` is a transport adapter only. It does not mount an
app endpoint, acquire permissions, discover a different origin, activate a route,
or implement course ownership/interlocks. Those remain with the route writer.

`createSignalKClient({ origin, accessToken?, allowInsecureLan?, fetchImpl? })`
returns:

- `getDiscovery({ signal? })`: fixed `GET /signalk`, maximum 64 KiB.
- `getSelf({ signal? })`: fixed `GET /signalk/v1/api/vessels/self`, maximum 1 MiB.
- `getVessels({ signal? })`: fixed `GET /signalk/v1/api/vessels`, maximum 4 MiB,
  for the existing Pi AIS reader. No incoming URL or path controls this request.
- `requestCourse({ method, target, routeId?, body?, signal? })`: maximum 64 KiB
  response and 32 KiB request. The only method/target pairs are course GET/DELETE,
  activeRoute PUT, and route GET/PUT. Paths are fixed v2 course or UUID route
  resources; arbitrary model paths, URLs, DELETE route resources, and autopilot
  endpoints are refused before any request.

Replies are `{ status, body: unknown }`. Non-success HTTP bodies are discarded.
204 has `body: null`. Errors are `SignalKClientError` with safe `code` values;
they contain no URL, token, upstream exception or response text. Callers validate
successful JSON against their own exact resource schema before acting on it.

Each request has a ten-second deadline including streamed response acquisition.
External cancellation settles even a nonconforming fetch. A streamed response
has a fixed byte buffer and at most 4,096 chunks. Redirects and cookies are
disabled; a returned-origin mismatch is rejected. Native/system TLS verification
is preserved. A bare HTTP origin is accepted by default only for Pi loopback.
An operator must explicitly choose `allowInsecureLan: true` for private IPv4 or
`.local` plaintext HTTP; that remains insecure transport, even with a token.

An access token comes from approved Signal K device access and is passed only
inside the Pi process. Absence permits reads only. The course writer must load
its operator-configured credential through its protected configuration, never an
incoming app request, query string, log, cloud telemetry or public response.
This checkpoint does not create/read a live credential or change a Pi service.

Tests exercise actual loopback HTTP, Bearer/JSON framing, refusal to forward a
token through a redirect, the exact endpoint/method table, byte/time/cancel
bounds, malformed response handling, and read-only defaults. They do not prove
approval on a physical Signal K installation or eliminate the stock v2
read-before-clear race. Course ownership checks belong to the writer.

Primary references:

- [Signal K security](https://signalk.org/specification/1.7.0/doc/security.html)
  specifies TLS and Bearer authentication; plaintext remains insecure.
- [Signal K server Course API](https://raw.githubusercontent.com/SignalK/signalk-server/master/docs/develop/rest-api/course_api.md)
  and [Resources API](https://raw.githubusercontent.com/SignalK/signalk-server/master/docs/develop/rest-api/resources_api.md)
  describe the v2 course and owned route resources. Runtime
  support must be checked; unsupported servers receive no invented capability.

No deployment or native version change is included.
