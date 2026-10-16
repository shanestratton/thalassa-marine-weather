# Pi update 7 controls

This prepares the guarded update7 assembler and rollback helpers. No live
bundle is staged and no Pi is installed by this source checkpoint. The final
build137 release must come first.

`pi-cache/scripts/stage-update7.mjs` accepts only an exact committed source
already in fetched `origin/master` ancestry with four native build137 values.
It archives tracked Pi source from that commit, never the Pi's checkout or
working files. It requires the inherited update6 components, wake keeper and
relay, radar parser/feed/grading/reader/routes, collision-rule and Signal K
mirrors, context retirement wrapper, and checked synchronization helpers. Missing components fail
before the destination is created. No runtime data, identity, credentials or
licensed chart assets are allowed in the archive inventory.

The update7 control directory and receipts are separate from update5/6. Their
reviewed anchor safety protocol is retained: the version1 loopback status and
shared `update5-maintenance.json` sentinel, fresh idle status, no persisted or
active anchor lease, non-root build/test before stopping the running service,
complete prior-code backup, code-only replacement and healthy guarded restart.
Uncertain recovery retains the guard. Install and rollback default to a
read-only plan; applying needs Linux root and Node22. The success receipt names
one shell-quoted rollback command, preserving the same cache path and port.

The relay stays unavailable unless both deployed server halves actually report
support and the account's exact source/rule context and recipient are freshly
confirmed. Radar has no default port and cannot open a hardware gateway slot.
An operator must explicitly configure the local Signal K NMEA passthrough.
No route starts it, and no radar control or image API is provided.

After the final build137 ships, fetch the real master reference and stage into
a new absolute directory:

```sh
git fetch origin refs/heads/master:refs/remotes/origin/master
node pi-cache/scripts/sync-wake-rule.mjs --check
node pi-cache/scripts/sync-signalk-protocol.mjs --check
node pi-cache/scripts/sync-radar-target.mjs --check
node pi-cache/scripts/stage-update7.mjs --commit <released-137-commit> --out <new-absolute-directory>
```

The generated manifest records frozen source/master commits, source file list,
payload digest, Node22 and pending physical acceptance. The bundle includes
`install.sh`, `rollback.sh`, `SHA256SUMS` and the Node helpers. Source fixtures
exercise frozen-master enforcement, original plan behavior, native version
binding, missing-module refusal, helper tampering, archive boundaries and
anchor lease refusal. Unix shell execution, real pi5 install/rollback dry run,
resource use and instrument/alarm acceptance remain required. Shane installs
at a safe daylight or dock moment, never while the Pi keeps an anchor watch.
