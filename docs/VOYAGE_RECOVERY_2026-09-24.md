# Butterfly Bay → Daydream Island recovery

User requested restoration of the morning passage on 24 September 2026.
Restoration committed and verified on the existing linked Thalassa backend.

## Result

- One recovered voyage: `voyage_recovered_pi_20260924_butterfly_daydream`.
- Observation window: **08:43:34–11:23:58 AEST, 24 September 2026**.
- GPS-estimated departure used by the existing summary RPC: 08:43:38 AEST.
- 820 original observations: 797 onboard Pi fixes and 23 existing app fixes
  during the final berthing interval. No interpolated coordinates or timestamps.
- Derived sampled distance: **15.6270887774607 nm**; duration about **2h 40m**.
- Maximum sample interval 40.010 seconds; maximum derived segment speed
  11.2722 knots. This is a recovered historical track, not a navigation route.

## Preservation and validation

The two completed app recordings were archived, not deleted:

- `voyage_1790198654824_u3f2yihih`: 1,113 entries.
- `voyage_1790206946135_uowiwphxt`: 2,447 entries.

All 3,560 original rows retain their IDs, timestamps, positions, measurements
and annotations; only `archived` changed. Current Log totals exclude these
archived copies, preventing duplicate mileage. The normal archive trigger
retired their ephemeral public live tails and removed those shadow points;
the durable original logs remain recoverable from the archive.

The final transaction ran under the owner's authenticated RLS context, checked
source counts/digests and absence of privacy/route/diary conflicts, then verified
all recovered timestamps/coordinates and cumulative totals. An identical
rollback-only dry run passed first. The unrelated owner history digest remained
unchanged. No diary links, public sharing configuration, live instruments or
anchor-watch configuration were changed. The Pi was queried read-only and was
not restarted.

The recovered voyage was also verified visually on the existing public voyage
map, with both recovery endpoint labels and the continuous observed track.
The web selector's date currently reflects its date-formatting timezone; the
stored UTC observations correspond to the AEST window above.

## Audit artifacts and rerun caution

Private mode-0600 source backups, manifest and reviewed SQL are in:
`/var/folders/gp/n1tg7r0s1tdgw69h13q60wdr0000gn/T/thalassa-sept24-recovery-5pONdA/`.

Pi source SHA256:
`c211edea52e47349984ca70628e749b80174725ee9b00d1f3c72673a87a3e5ee`.

`scripts/audit-sept24-pi-voyage.mjs` and
`scripts/prepare-sept24-voyage-recovery.mjs` are deliberately scoped one-off
tools. Preparation performs read-only remote queries and generates SQL locally;
it does not apply changes. The application SQL refuses to rerun once this
recovery exists. Do not reuse either script for another voyage without a fresh
audit, IDs, source boundaries and user request.
