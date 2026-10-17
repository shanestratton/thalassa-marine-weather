# Build 138 forecast steering

The passage summary's leg list and the forecast face of the Passage HUD show a course to steer only when a verified regional current series covers the actual place and UTC time. The displayed through-water speed is explicit. This is a forecast vector triangle, separate from build 136's live measured-current steering.

A finite zero current or a true zero-degree heading remains valid. Missing, masked, expired or out-of-time current data stays unavailable. An opposing or crossing current stronger than the planned speed has no steer heading. The HUD also withholds this advice on an unchecked joining estimate, an assumed wind-speed plan and a tacking/VMG leg, where a single course and through-water speed would imply false precision. Coarse ocean and model-tide fields do not resolve a channel or bar, and no geometry, tide credit, alarm or followed route changes.

Each field stays in RAM. Its request is bounded by all route vertices and the existing eight-tile/eight-MiB regional loader, with cancellation and account/vessel fences. Satellite Mode performs no fetch. The source run, sampled clock and generation are available in the advice's accessible title. New regional production policies and signing keys remain closed, so the shipped loader presently yields unavailable until the separate provider/licence/hosting review is complete. No global display asset or generic marine snapshot is substituted.

Focused checks cover the current vector's TO convention and units, north/zero values, unholdable drift, unknown coverage, later-leg clocks, dateline bounds, Satellite Mode and account/vessel changes. Existing summary and HUD regressions remain applicable. This source checkpoint is not a current-provider activation or a full build 138 release.
