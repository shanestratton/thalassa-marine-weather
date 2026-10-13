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

## Install and update (owner only)

The source repository is private (2026-10) and Pi setup is by invitation during the beta, so the app no longer shows an
install command. `install.sh` downloads `pi-cache/` with a fine-grained GitHub token that has read-only **Contents**
access to `thalassa-marine-weather`. That token reads the whole private repository, so only the owner's own Pis get one,
one token per Pi. It is asked for once, with nothing echoed, and kept in a root-only file, `/etc/thalassa/github-token`.
The token never appears in a URL or on a command line. On Raspberry Pi OS the login user usually has passwordless sudo,
so the real protection is that the token is read-only, single-repository, expiring and revocable.

- **First install**, and the first update of a Pi set up before 2026-10 (its old installer has no token support), from a
  Mac with this repository: `scp pi-cache/install.sh <user>@<pi>:/tmp/ && ssh -t <user>@<pi> sudo bash /tmp/install.sh`
- **Update** on the Pi: `sudo thalassa-pi-cache-install`, a root-owned copy of the installer that every download
  refreshes. It never runs the copy in `/opt`, which the service user can write.
- **Rebuild in place** without downloading: `sudo bash /opt/thalassa-pi-cache/install.sh`
- **Wrong or expired token:** `sudo rm /etc/thalassa/github-token`, then update again to paste a new one.

A Pi that runs from a full checkout (`~/thalassa-marine-weather`, updated with `git pull` and `redeploy.sh`) needs the
same kind of token for `git pull`: see `docs/GOING_PRIVATE.md`.

## Runtime

Node.js `>=20.18.1` is required by the pinned HTTP transport. `install.sh` upgrades an older Pi runtime through the
NodeSource 22.x repository and aborts before dependency installation or service restart if that minimum is not met.

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
- `ENC_WATCHER_ENABLED` and `ENC_SOURCE_RECONVERT_ENABLED` no longer start anything for o-charts sets (Pi update 3):
  the chart vault opens them in memory, whatever these say.

To exercise the complete flow from another device, both the LAN-bind and unsafe-admin switches are required, plus the
exact browser origin when applicable. Do not bypass certificate pinning, expose the service to an untrusted network,
or add a plaintext fallback.

## Licensed charts: the chart vault (Pi update 3, 127-C-d)

o-charts (2026-10-10): "Storing unencrypted data on any medium, and especially in the cloud, is strictly prohibited by
the terms of the licenses signed with the chart providers." So licensed cells are never files here:

- **`thalassa-chart-vault`** (`dist/vault/main.js`, `systemd/thalassa-chart-vault.service`) is the only process that
  turns a delivered `.oesu` into chart data, in its own RAM, on demand, through oexserverd's FIFOs. Nice 10 and
  `CPUWeight=10` (its `CPUQuota` turns the cgroup cpu controller on, so thalassa-cache's drop-in sets `CPUWeight=300`),
  two cores at most, never swapped, killed first, no core dump, no network (a unix socket to thalassa-cache only). It
  writes a catalogue only (`enc-charts/vault/vault-index.json`, `removed.json`). Every limit is in
  `src/vault/limits.ts` (provisional until the calypso measurement). thalassa-cache asks it for its status every 5 s
  and tells it the watch state every 30 s (`startVaultLink`), so `/api/admin/status` answers from memory and never
  waits on the vault's loop.
- **thalassa-cache is the front door** for `/api/enc/*`: `Cache-Control: no-store`, the boat's own Wi-Fi only (never
  the router's address, the tailnet, loopback or the Pi itself), and an enrolled device's
  `X-Thalassa-Chart-Device` token (codes from `node dist/vault/enrolCode.js`, at most five devices). It streams the
  vault's bytes, signed over the hash the vault checked, and never parses a licensed cell.
- Only open charts (NOAA, `src/chartLicence.ts`) are kept as files, in `enc-charts/open/`. The parser is a mirror of
  `tools/senc-extractor` (`src/sencEngine`, `scripts/sync-senc-engine.mjs --check` in CI); never edit it here.

## Internet gate across restarts (`THALASSA_PI_WAN_UPLINK`)

The Pi cannot tell a satellite link from ordinary internet on its own, so by
default it shuts its internet gate on every restart and waits for the app to
re-apply the skipper's policy — the diary and telemetry relays stand down until
then. If this Pi only ever talks through an ordinary link (a 4G router, marina
Wi-Fi), declare it in `.env` and the gate stays open across restarts:

```
THALASSA_PI_WAN_UPLINK=ordinary
```

`satellite` pins the gate shut instead. Anything else is treated as undeclared.
The app's own policy pushes still apply on top.
