# Pi update 6 staging

Update 6 packages the private track reader, source-clock engine and Systems
measurements, Signal K read stream/notifications and interlocked course writer.
This source checkpoint does not stage or install a live Pi release.

`pi-cache/scripts/stage-update6.mjs` requires an exact full commit already in
the fetched `origin/master` history and exactly four native build136 values.
It archives tracked `pi-cache` source from that commit, never working files or
the Pi's checkout. Its manifest records the source and master commits, tested
Node22 runtime, included parts and hardware acceptance still required. Runtime
data, credentials, identity keys and licensed chart assets are forbidden.

After the final build136 source has shipped and master is advanced, fetch the
actual master reference, then stage to a new absolute directory:

```sh
git fetch origin refs/heads/master:refs/remotes/origin/master
node pi-cache/scripts/stage-update6.mjs --commit <exact-released-136-commit> --out <new-absolute-directory>
```

The resulting bundle contains `install.sh`, `rollback.sh`, the Node helpers,
`source.tar.gz`, `manifest.json` and `SHA256SUMS`. Both shell entry points
default to a read-only plan. The installer snapshots the reviewed update5
protocol in a separate update6 control/backup directory; existing update5
artifacts are unchanged. It deliberately keeps the version1 loopback status
endpoint and shared atomic `update5-maintenance.json` sentinel so the running
service can block new anchor watches during install and rollback.

Applying requires Linux root and Node22, a protected root-owned bundle, a fresh
idle guard response and no active or unreadable persisted anchor lease. Source
build/tests run as the non-root service user while the previous code still
runs. The installer then holds and rechecks the guard, takes a complete prior
code backup, and changes only the fixed code inventory. It retains `.env`,
cache, identity, chart and reference data. Uncertain recovery retains the guard.
The success receipt includes one shell-quoted rollback command with the same
cache directory and port; backups and displaced code remain available.

The source keeps course writes disabled unless the operator independently
configures approved server credentials and the explicit course-write switch.
Device access approval and physical tank/RPM source checks still belong aboard.
Staging does not grant them or enable any remote helm controls.

Seven actual Node checks pass: frozen master ancestry, unchanged plan mode,
native version binding, runtime/source/archive boundaries, helper tampering,
anchor leases and archive traversal/link refusal. Shell wrappers are exercised
by that same test on Unix. A real pi5 install/rollback dry run, resource use and
physical instrument acceptance remain pending. Shane runs an actual install at
a safe moment in daylight or at a dock, while the Pi is not keeping a watch.
