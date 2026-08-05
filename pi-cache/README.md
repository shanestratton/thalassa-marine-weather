# Thalassa Pi Cache — development-only public-beta boundary

The production Thalassa public beta does **not** connect to this service. The current LAN protocol is not yet an
authenticated encrypted transport, so pairing signatures are not treated as permission to send private app data over
HTTP. Do not claim Pi workflow coverage in public-beta testing.

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

## Explicit unsafe development flags

These switches are not authentication and do not make HTTP safe. Use them only on an isolated trusted development
network:

```text
THALASSA_PI_LAN_BIND=1
THALASSA_UNSAFE_ADMIN_API=1
THALASSA_CORS_ORIGINS=capacitor://localhost,http://localhost:5173
ENC_WATCHER_ENABLED=true
```

- `THALASSA_PI_LAN_BIND=1` changes the listener from loopback to `0.0.0.0`.
- `THALASSA_UNSAFE_ADMIN_API=1` enables private/admin routes, app hosting, and prefetch scheduling.
- `THALASSA_CORS_ORIGINS` is a comma-separated exact allowlist. Wildcards, credentialed URLs, and origins with paths
  are ignored.
- `ENC_WATCHER_ENABLED=true` starts the watcher only when the unsafe-admin flag is also enabled.

To exercise the complete development flow from another device, both the LAN-bind and unsafe-admin switches are
required, plus the exact browser origin when applicable. Do not add a bearer token over HTTP as a workaround; the
release blocker is authenticated encryption, not merely possession of a reusable secret.
