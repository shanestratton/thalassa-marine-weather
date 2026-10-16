# 139-04 composite field foundation

`services/engine/exclusionField.ts` compiles original RESARE entry restrictions (7/8), TSEZNE polygons, explicitly supplied manual no-go polygons and indicative marine-park caution areas into an independent RAM-only geometry snapshot. It copies no chart names or cell identifiers. Anchoring/fishing/no-wake restrictions are not reinterpreted as transit prohibitions. Hard separation-zone avoidance is a conservative planning policy, not a claim that every real-world crossing is legally prohibited.

The shared WGS84/topology validator bounds selected geometry to 2,000 features / 50,000 vertices / 4 MiB with a two-million-comparison topology ceiling; source scanning is separately capped at 16,000 objects. Malformed, unsplit dateline and non-polygon hard constraints refuse the review rather than disappearing. Missing chart-class coverage still needs to be disclosed by the caller.

Rasterization produces private masks without changing chart grids, depths or preference flags. It includes polygon interiors, holes, tiny islands, boundary supercovers and both sides of exact grid-edge/corner contacts. Boundary segments are clipped before walking the selected grid. The 2.5-million-cell and eight-million-operation ceilings are fixed. Park caution never becomes a hard transit prohibition.

The separate final-line audit checks complete segments against original polygon geometry after all route splices. It detects narrow crossings between route vertices and exact boundary contact. Grid masks and sampled route points are insufficient proof on their own. The complete audit has its own geometry/operation limits and refuses unsupported route geometry.

Seventeen focused cases pass, including thin polygons, source-copy independence, holes, exact boundaries, tiny islands, stale callbacks, malformed topology, bounded grids and unchanged chart arrays. The module is not yet called by the application. Remaining work is per-request grid/cost integration, refusal/final-service guards, explicit manual no-go controls and lifecycle fencing, traffic-lane guidance and verified marine-park data wiring. No compiler, configured size or live routing behavior is claimed for this foundation.

Restriction meanings come from the existing canonical `s57Restrn.ts` table and [IHO S-57 Appendix A, chapter 2](https://iho.int/uploads/user/pubs/standards/s-57/31ApAch2.pdf). Traffic routing must distinguish planned track geometry from the vessel's actual heading through current; this field alone establishes no COLREG compliance.
