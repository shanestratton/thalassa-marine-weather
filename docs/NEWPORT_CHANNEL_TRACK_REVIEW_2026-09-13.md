# Newport chart-track guidance — local trial review, 13 September 2026

This is a narrowly scoped **trial plotting policy**, not an official navigation
approval, survey, or confirmation of today's depth, tide, traffic or notices.
It does not extend the existing automatic canal-gate profile's authority.

## Evidence and exact scope

- Installed licensed ENC `OC-61-10RCS5`, edition 1, issued 7 March 2022:
  `RECTRC` feature 407, `CATTRK=1`, `ORIENT=183`, `TRAFIC=4`.
- The finite recommended track is `[153.095128, -27.1675]` to
  `[153.093142, -27.201389]` in longitude/latitude order. Both travel directions
  are eligible; no line is extrapolated beyond those endpoints.
- `NAVLNE` 406 (`CATNAV=3`, `ORIENT=183`) corroborates that finite section.
  Its additional landward segment is **not** treated as a navigable extension.
- The official [MSQ Moreton Bay Beacon to Beacon guide, MB-4 (PDF page 6)](https://www.msq.qld.gov.au/-/media/TMROnline/msqinternet/msqfiles/home/boatingmaps/moretonbaybeacon.pdf)
  was inspected as a rendered full page. Its nautical information is dated
  **26 August 2021**, not 2026. Newport's western approach is distinct from
  Scarborough's neighbouring approach and the bay's larger shipping channels.
- [MSQ's navigation guidance](https://www.msq.qld.gov.au/Safety/Navigation-buoys-marks-and-beacons)
  cautions small craft to keep to starboard in larger shipping channels.
  This policy does not turn every leading line or shipping channel into a
  centreline-following instruction.

Policy revision: `newport-rectrc407-msq-mb4-review-20260913`.
Review timestamp: `2026-09-12T23:30:05Z`.
Expiry: `2026-09-19T21:12:59Z`, the same bounded lease as the parent canal
profile. Daily water-data refresh does not renew this chart/track review.

## Calculation boundary

1. Obtain the original SevenCs proposal without modifying it.
2. Only consider a sustained, near-parallel overlap with this reviewed finite
   track. Crossings, ambiguous branches, repeated visits and absent/stale chart
   evidence do not authorize guidance.
3. Submit at most eight ordered chart-track constraints for **one** further
   SevenCs calculation. Every bend in the covered track is retained; points
   already covered by the endpoint conformity tolerance are not duplicated.
4. Check the returned continuous geometry, ordered passage, backtracking and
   endpoint consistency. The 20 m corridor tolerance is a geometric test, not
   under-keel clearance. Endpoint consistency has a separate 2 m bound.
5. Re-read chart data, registration, policy revision and lease. Never locally
   move a route line while retaining checker results for the old geometry.
6. In canal mode the original local prefix stays unchanged. The chosen
   continuation still passes water/obstacle, gate direction and seam checks.
   The complete joined route then receives a fresh independent local review.

Failed or timed-out optional guidance retains the unchanged original proposal
with an explicit notice. Account changes and caller cancellation discard the
attempt. A failed primary calculation never gets a straight-line substitute.
Warnings from an initial proposal that differ from the guided response are
retained with their origin clearly labelled, not presented as checks of new
geometry. Provider findings and local checks remain separate.

## Release boundary

This implementation is local. The client requires the entitled server's explicit
`channelGuidance: true` capability; an older backend takes the original provider
path. No paid services, trial entitlements or review expiry are expanded. No
route is saved, activated, published or cleared for navigation by this policy.
