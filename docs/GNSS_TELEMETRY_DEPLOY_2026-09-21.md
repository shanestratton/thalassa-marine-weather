# GNSS telemetry deployment — 2026-09-21

User explicitly approved a brief Pi restart. Only the GNSS telemetry reader's compiled module and matching source were deployed; no environment, data, settings, or other service files were modified.

## Scope and verification

- Host: `calypso`; service: `thalassa-cache.service`.
- Target: `/opt/thalassa-pi-cache/dist/trackSignalk.js`.
- Local `npm run build` succeeded; 26 GNSS/track/telemetry/LAN tests passed.
- Compared the downloaded live module with the locally compiled module. The entire difference was the GNSS helper and its invocation; there were no unrelated live changes to overwrite.
- The staged module passed the Pi's Node 22 syntax check before replacement.
- Preserved the original file with `cp -p`, replaced the target atomically on the same filesystem, and restarted only `thalassa-cache.service`.
- Restart time: 2026-09-21 00:28:49 UTC / 10:28:49 AEST.
- Health returned `ok` at process uptime 0.62 seconds. Follow-up health at 25.30 seconds remained `ok`; systemd was active/running with `NRestarts=0`.
- Telemetry publisher reported `publishing: true`, `lastOutcome: sent`.

## Exact artifacts

Backup, retained on the Pi:

`/opt/thalassa-pi-cache/dist/trackSignalk.js.pre-gnss-20260921T002756Z.bak`

Original/backup SHA-256:

`1f514436fc55dd95898450128d146d7412f1b44667e2c2deeb3b1377115228fb`

Deployed SHA-256:

`2da14c4eb3e15b94f0f393acff03a585d3b90eef9073c17b2ce40bb68c657e6c`

The deploy command included automatic exact-module restoration and another service restart if restart or health verification failed. That rollback was not needed.

## Verified live measurements

At 00:29:13 UTC, `/api/telemetry` reported:

- Receiver: `ydwg-tcp.YD`.
- Satellites: 31.
- HDOP: 0.50 (dimensionless).
- Fix quality: 2, corresponding to the receiver's `DGNSS fix`.
- Each diagnostic retained its original 00:29:13 UTC measurement timestamp.
- `position_at` was also 00:29:13 UTC; row `reported_at` was 00:29:13.980 UTC.
- No horizontal accuracy in metres was reported or inferred.

A separate read of one Signal K document through the deployed module verified that the diagnostic receiver exactly matched the position receiver and that all three exported values matched that receiver's actual leaf envelopes. No coordinates or credentials were included in verification output.

## Matching source alignment

After the successful module deployment, the matching `/opt/thalassa-pi-cache/src/trackSignalk.ts` was also approved for alignment so a future Pi build preserves this change. Comparing the live source with local source confirmed that their only difference was exactly the same GNSS helper and invocation. The source was backed up and replaced atomically with unchanged permissions. No additional restart or Pi build was performed; the service remained active/running with the same 00:28:49 UTC start time.

Source backup, retained on the Pi:

`/opt/thalassa-pi-cache/src/trackSignalk.ts.pre-gnss-20260921T003040Z.bak`

Original/backup source SHA-256:

`a895e8491fd392b87c24ca30f442ab8d68055f160025f2f8d8dacc2664f4910c`

Deployed source SHA-256, identical to local source:

`36b4ea2274958105c44cc5903e6296194e751c1433fd3aa28127d58ff0ae7eb8`

An independent local TypeScript transpilation using the project compiler options proved that this exact source emits the exact deployed module bytes (`pairedSourceMatchesBuiltModule: true`). Both Pi hashes matched that verified local source/module pair, and the compiled-module hash remained unchanged after the source-only alignment.

The local repository also contains separately tested app diagnostic freshness fixes, which were not part of this Pi deployment.
