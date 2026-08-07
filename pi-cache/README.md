# Thalassa Pi Cache — native pinned-TLS public-beta boundary

The native Thalassa public-beta candidate may connect only when its Pi TLS verifier is present. Pairing pins this
service's public key, subsequent app traffic uses HTTPS, and browser, old, or stripped native shells fail closed rather
than falling back to plaintext or ordinary platform trust. The service still keeps LAN/private administration off by
default; the operator must deliberately enable the exact boundaries below.

## Safe defaults

With no environment flags, the server:

- listens only on `127.0.0.1:3001`;
- sends no wildcard CORS header (browser origins must be explicitly allowlisted);
- exposes redacted `/health` and `/status` responses;
- permits bounded, named fixed-provider weather/tide/GRIB/tile cache reads;
- disables configuration, cache purge, generic passthrough, chart/ENC, pairing, OSM route, diary relay, bundled-app
  hosting, prefetch scheduling, and the ENC filesystem watcher.

`/status` never returns prefetch coordinates, user/owner IDs, Pi identity, diary relay configuration or queue detail,
filesystem paths, or credentials.

## Runtime

Node.js `>=20.18.1` is required by the pinned HTTP transport. `install.sh` upgrades an older Pi runtime through the
NodeSource 20.x repository and aborts before dependency installation or service restart if that minimum is not met.

## Explicit LAN/admin flags

These switches are not authentication and do not make an untrusted network safe. Use them only on an isolated trusted
boat LAN with the native pinned-HTTPS client:

```text
THALASSA_PI_LAN_BIND=1
THALASSA_UNSAFE_ADMIN_API=1
THALASSA_CORS_ORIGINS=capacitor://localhost,http://localhost:5173
# Optional: exact private origins the admin download/proxy tools may contact.
THALASSA_UNSAFE_PRIVATE_UPSTREAM_ORIGINS=http://chartbox.local:8080
# Optional: exact non-production Supabase origin selected through SUPABASE_URL at startup.
THALASSA_UNSAFE_SUPABASE_ORIGINS=http://supabase.lan:54321
ENC_WATCHER_ENABLED=true
```

- `THALASSA_PI_LAN_BIND=1` changes the listener from loopback to `0.0.0.0`. **This is the flag that decides whether
  anything on the boat network can reach the Pi at all** — without it the service starts, reports itself healthy, and
  answers nobody but localhost. An existing Pi whose `.env` predates this flag will not have it: `redeploy.sh`
  preserves `.env` by design, so the line has to be added by hand once.
- `THALASSA_UNSAFE_ADMIN_API=1` enables the mutable/private surfaces — `/api/configure`, `/cache/purge`, the
  passthrough tools, `/api/misc/proxy`, the raster-chart download/delete API, `/api/admin/status`, the ENC watcher,
  app hosting, prefetch scheduling, and a 100 MB JSON body limit.
- `THALASSA_PI_APP_API` gates the routes the **app** needs — pairing, ENC charts, the OSM overlay and the diary relay.
  It is the one flag here that **defaults ON**; set it to `0` to turn those off. Those four used to sit behind
  `THALASSA_UNSAFE_ADMIN_API`, which meant pairing a phone required also exposing an unbounded outbound proxy. They
  carry their own defences (pinned TLS, trust-on-first-use pairing, per-payload signatures), and network exposure is
  already gated by `THALASSA_PI_LAN_BIND`, so mounting them on a loopback-only server reaches nobody.
- `THALASSA_CORS_ORIGINS` is a comma-separated exact allowlist. Wildcards, credentialed URLs, and origins with paths
  are ignored.
- Public chart/vendor URLs remain available, including validated cross-origin CDN redirects. Private or carrier-grade
  destinations require an exact `THALASSA_UNSAFE_PRIVATE_UPSTREAM_ORIGINS` entry as well as unsafe-admin mode. DNS is
  checked at connection time and on every redirect; loopback, link-local, metadata, multicast, translated/tunnelled
  IPv6, and reserved ranges remain blocked.
- The production Supabase origin is pinned in the service. A development origin must be selected through
  `SUPABASE_URL` at process startup, appear exactly in `THALASSA_UNSAFE_SUPABASE_ORIGINS`, and, when private, also
  appear in `THALASSA_UNSAFE_PRIVATE_UPSTREAM_ORIGINS`. `/api/configure` may confirm but cannot change that authority.
  The diary relay accepts only the exact `/functions/v1/diary-relay` endpoint derived from this startup origin; legacy
  off-origin relay credentials are scrubbed and their pending rows require repair before any startup retry.
- `ENC_WATCHER_ENABLED=true` starts the watcher only when the unsafe-admin flag is also enabled.

To exercise the complete flow from another device, both the LAN-bind and unsafe-admin switches are required, plus the
exact browser origin when applicable. Do not bypass certificate pinning, expose the service to an untrusted network,
or add a plaintext fallback.
