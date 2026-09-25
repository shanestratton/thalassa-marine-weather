# Public diary map pin repair — 25 September 2026

The two later public diary posts published on 24 September had photos and place
names, but both latitude/longitude and their voyage links were null. The public
map correctly omitted entries without coordinates; no map-rendering change or
public access-policy change was needed.

## Repaired entries

- **Daydreaming, Cold Beers & a Netflix Emergency**: positioned from the original
  first gallery photo (`output/daydream-2026-09-24/01-Daydream-welcome.jpg`), captured
  at 11:35:43 AEST on 24 September. Its GPS is approximately 20.253912° S,
  148.814438° E, with reported horizontal positioning error 4.75 m. Linked to the
  recovered Butterfly Bay → Daydream voyage. The pin is the photo's location,
  not an inferred yacht berth. Published upload copies had GPS metadata removed.
- **Seventy-Five Boats & One Floating Test Lab**: positioned approximately from
  the nearest recorded vessel fix to `IMG_2146.PNG`'s original capture time,
  11:07:13 AEST on 23 September. The recorded fix was 9.808 seconds later, at
  approximately 20.116302° S, 148.983233° E. Linked to that day's recorded voyage.
  This is a historical story location, not an exact photo geotag or interpolation.

## Procedure and safeguards

`scripts/repair-sept24-diary-map-locations.mjs` defaults to a rollback rehearsal.
The verified repair was committed with `--apply` after that rehearsal passed.
It matches only the two exact entries, owner and boat, checks the unchanged
pre-repair snapshot and voyage evidence, and updates coordinates, voyage link,
revision and modification time. Public status, text, media and creation dates
are preserved. Existing positioned entries are untouched.

The full before-snapshot and repair provenance were retained privately at:
`/var/folders/gp/n1tg7r0s1tdgw69h13q60wdr0000gn/T/thalassa-diary-pin-repair-DfDYxQ`.
Do not re-run the write after success; its null-coordinate precondition will
reject an already-repaired entry. Verify with read-only queries instead.

The app now also gives a non-blocking publishing notice when a diary entry has
no map location. It does not silently substitute the current vessel position
for historical entries. Tests cover missing/partial coordinates and pins
appearing when valid coordinates are later supplied.
