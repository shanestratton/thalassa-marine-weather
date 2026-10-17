# Pi update 5: staged source and guarded installation

Prepare the app and Pi code first, then freeze one commit and pass its complete release validation. Create the bundle from that exact commit, outside the repository:

```sh
node pi-cache/scripts/stage-update5.mjs --commit <40-character-commit> --out /absolute/new/directory
```

The result contains `manifest.json`, `source.tar.gz`, `SHA256SUMS`, `install.mjs`, `rollback.mjs` and `update5.mjs`. `git archive` supplies tracked source only. The source inventory rejects secrets, runtime caches, identities and delivered/decrypted chart assets. The manifest names update 5, derives its app build from all four matching native configurations in the frozen commit, and records that exact commit. Only the reviewed app builds 133, 134 and 135 are accepted by both staging and installation; a mixed build or an unreviewed future build is refused. Build 135's imported weather and observation features do not change this installer/anchor-lease protocol. Staging is neither an installation nor proof of hardware acceptance. Checksums detect changes; retain the printed inventory digest with the independently verified release evidence.

Transfer this reviewed bundle to the Pi and keep it under root ownership, outside the service-writable install directory. Check `sha256sum -c SHA256SUMS` against the recorded digest. Running `node install.mjs` prints a plan and changes nothing. An explicit `sudo node install.mjs --apply` builds/tests locked dependencies as the existing non-root service user and uses the existing tested Node 22 runtime. It installs no SDK, changes no accounts and applies no hosted database migration.

The live installer requires the loopback-only `/api/update5/status` guard protocol. It refuses an active anchor watch, an unexpired persisted session lease, a missing/unknown/stale status or an existing maintenance sentinel. After writing its sentinel it rechecks live status before stopping any service. The server refuses new anchor-watch starts while the sentinel exists. An older Pi without this protocol is refused; its first guard-capable bootstrap must be reviewed and rehearsed at the dock, with the physical watch independently confirmed off. Do not bypass the guard to save a visit.

The installer finishes a complete code backup before replacing any live code. `.env`, `cache`, `identity`, `enc-charts`, `reference`, the command lock and recorded tracks stay in place. It restarts the previously active vault and cache, requires healthy guarded status and restores previous code if the update fails. If recovery is uncertain, the sentinel remains and the installer reports failure. A confirmed healthy service releases the sentinel. A stale sentinel needs investigation; deleting it is not a way to override an active watch.

Rollback is one command from the same protected bundle:

```sh
sudo node rollback.mjs --apply
```

Rollback uses the same anchor/lease checks and retains runtime data. The previous code backup is retained. A `--cache-dir /absolute/actual/cache` and `--port 3001` can name an existing nonstandard deployment; the service must observe that exact sentinel or the operation refuses.

Before a real installation, rehearse install, failed health recovery and rollback on the pi5; measure memory, CPU, disk space and alarm latency; verify the chart vault rereads cells in memory; check the polar engine gates, pressure history, offline assets and real alarm delivery. Source fixtures and hosted CI do not establish these hardware results. Track upload remains held pending its explicit database/deploy approvals. No real Pi has been updated by this preparation.
