# Owner-only radar snapshot (held)

Apply `20261016165318_pi_radar_owner_snapshot.sql` only after the reviewed radar
relay migration. This packet adds no producer, cron, notification or live data.

`pi_radar_owner_snapshot(p_pi_device_id uuid)` is an authenticated
`SECURITY INVOKER` read through the existing owner RLS. Its fixed header is
`{schema:1, checkedAt, owner, context, contextRevision, retired, evaluatedAt,
more, alarms}`. Owner contains only owner/Pi/pair/feed identifiers. Facts contain
only key, contactKey, episodeId, kind, raisedAt, sourceAt, reportAt, cpaNm,
tcpaMin, rangeNm, bearingDeg, lost and ackedAt. Original measurement and ACK
clocks are preserved; there are no frames, vessel names, positions or URLs.

The enabled relay ownership check is a separately revoked, authenticated-only
boolean definer helper in `thalassa_radar_private`. It exposes no relay table
columns or credential values. The public function remains an invoker.

Exactly one caller-owned enabled relay context must match the requested Pi.
Aliases are counted before age filtering, so an older enabled alias cannot be
silently replaced by the newest row. A fresh context update and original active
evaluation must both be within 30 seconds. Missing, ambiguous, stale or
incoherent state returns owner/context/revision/evaluation null and no facts.
Only fresh explicit retirement can return `retired:true` with its same profile.
No row is not evidence that radar is off.

At most 20 unresolved facts are returned, with close-quarters danger first and
explicit `more:true` on overflow. Active acknowledged facts remain included so
the phone computes its mute from the original ACK time. A context heartbeat
does not prove connected radar or fresh target assessments; the consumer must
retain unknown feed state and inspect each fact's own clocks. ACK remains the
existing owner-only `acknowledge_pi_radar_alarm(key, contextRevision)` RPC.

`supabase/tests/pi-radar-owner-snapshot.mjs` applies the actual held migrations
to an isolated PGlite instance. Its 104 checks cover RLS/ACL secrecy, foreign and
disabled owners, exact binding, stale/future clocks, ambiguous aliases, explicit
retirement, original ACK age, 54 contacts capped to 20, and zero notification
queue rows. This is isolated behavior proof, not PostgreSQL concurrency or live
backend deployment. The weather source's separate PostgreSQL 17.6 race proof
passed run 38935427858 against source 92f8e1cf; its immutable receipt is outside
the repository at `outputs/Build137 weather PostgreSQL proof.json`.
