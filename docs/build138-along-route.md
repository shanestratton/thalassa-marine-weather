# Build 138: along-route reference places

This is a source-only child of the frozen 138 constraint checkpoint. It does
not acquire, publish or activate a catalogue. The existing marine catalogue
publication hold remains in place. An unpublished or incomplete dataset must
stay visible as unavailable/partial; it cannot become an empty-known region.

The opt-in `facilities` dataset is separate from existing `osm`, `places` and
`noaa` outputs. Released clients keep reading their original datasets, whose
schemas and defaults are unchanged. New facility kinds must never be written
into their old OSM shards. The facilities parser accepts explicit marina and
boat-fuel roles only; a single source object can retain both. It does not
infer marine fuel from a roadside `amenity=fuel`, or interpret reported hours
as permission, availability or a bridge opening.

The source classification follows the OSM project's documentation for
[marinas](https://wiki.openstreetmap.org/wiki/Tag:leisure%3Dmarina),
[boat fuel](https://wiki.openstreetmap.org/wiki/Tag:waterway%3Dfuel) and
[small-craft fuel stations](https://wiki.openstreetmap.org/wiki/Tag:seamark:small_craft_facility:category%3Dfuel_station).
Derived public data retain OpenStreetMap/ODbL credit and the complete adapted
generation; no chart-vault input or boat data enters that builder.

Every facilities generation carries a cumulative, stable regional inventory,
each with its actual source clock and SHA-256 of the retained normalized input.
The original transport hash remains in its acquisition receipt. The manifest
uses the oldest included source clock, so receiving or updating one region
cannot renew an older region's apparent age. The new acquisition path reads
the PBF header's `osmosis_replication_timestamp` using the documented
[bounded header-only Osmium fileinfo command](https://docs.osmcode.org/osmium/latest/osmium-fileinfo.html).
Missing, malformed or future source clocks refuse; there is no receipt-time
fallback. New facilities acquisition is capped at 512 MiB transport and 2 GiB
expansion; cumulative local feature inputs are capped at 2 GiB. No such
acquisition is authorized or executed by this checkpoint.

The existing immutable-object/readback/manifest-last/CAS machinery remains.
Facilities publication planning additionally refuses dropping a previous
regional cohort, regressing its source clock or replacing its source hash
under the same clock. A future real plan must include all retained regional
cohorts and review the exact cumulative source/output/storage inventory.

The route projector uses short great-circle legs and split dateline windows,
with a 5 NM reference corridor. It refuses more than 16 public area cells,
8192 original vertices, 4096 subdivided segments, 10,000 reference records or
500,000 projection comparisons. It shows at most 128 ordered rows and labels
that displayed limit. Polar/antipodal or oversized requests ask for an
individual leg; there is no implicit global strip download. Repeated route
passes with no unique visit retain an unknown ETA. Planning times require a
real stated speed and departure; an off-route reference never certifies a
navigable approach, docking permission, fuel stock or bridge clearance.

The Python builder's actual temporary generation is consumed by the app's
manifest/shard parser in the fixture tests. All test positions and records are
synthetic. Initial builder/protocol/projector proof is separate from the
remaining complete local ENC reader, report/HUD wiring and actual browser
proof.

The complete reader now uses only installed chart cohorts and releases each
NOAA shared resident lease after copying bounded primitive bridge summaries.
It never downloads or reconverts a chart. Missing BRIDGE layers, oversized
cohorts, read errors and geometry limits make the complete bridge portion
unavailable. Uninstalled route windows are labelled partial. Protected source
licence, rather than a country prefix, determines the aboard-only status and
removes its external source link. Bridge span/route intersections use spherical
geometry; disconnected MultiPoint objects do not invent a span between them.

The lazy Route report action defaults to public references already aboard and
the complete installed bridge reader. A separate explicit public download reads
only the two public catalogue namespaces, at most 16 cells each. Satellite Mode
refuses that action before work begins. The complete operation has one
30-second lifetime, including local weather sampling. Weather uses the existing
aboard GRIB/grid sampler at each reference's actual constant-speed ETA; there is
no online weather fallback. An unstated speed/departure or ambiguous repeated
visit has no ETA/weather. Missing gust/pressure stay unknown, never zero.

Reports exist only in RAM, with exact account generation, boat, vessel/policy,
route/timing, chart inventory, catalogue deletion and weather-source fences.
Changing a boat A to B and back cannot revive a pending result. The HUD reads
only the explicitly loaded report for its exact displayed line and a qualified
progress, with access/transit unverified. This reference line does not turn on
following or change a route, watch, tide calculation, clearance or bridge gate.
Private chart summaries never enter PDF or GPX input/bytes, storage or workers.
No real catalogue acquisition, publication, provider activation, database
mutation or Pi installation has been performed.

Proof checkpoints (local synthetic data only):

- Foundation: 32 cases in four app suites; 39 Python source/build/publication
  cases. Source-clock admission was tightened so a builder cannot produce a
  cohort newer than builtAt, which the actual app parser correctly refuses.
- Integrated service/privacy: 87 cases in ten suites, including real PDF/GPX
  argument/byte separation, caller cancellation, hung-dependency deadline,
  same-tick A/B/A fencing, unavailable coverage and unknown weather.
  `work/validation138-along-final-focused-corrected.log`.
- Chrome/WebKit: four actual cases at 300/375 px and 130% text, using the real
  public cache, protected-chart RAM reader, weather sampler, report and next-up
  components. Zero outbound attempts, chart-version retirement and no private
  chart text in localStorage. `work/validation138-along-browser-second.log` and
  `work/along-route138-final-browser-proof/`.
- First browser evidence remains in `work/along-route138-browser-proof/`:
  the original Route report header crowded its title and export controls.
  The header now wraps inside the unchanged 85dvh modal cap. Its first harness
  used the wrong close-button name; that test-only name was corrected to the
  existing real Close label, without removing the assertions.
- First export boundary test hit jsdom's missing Blob.text method; the harness
  now reads the actual produced Blob using FileReader. The original failed log
  remains `work/validation138-along-final-focused.log`.

Whole-app type and configured production-size proof for this child remain a
separate step. The frozen parent's results are not reused as proof here.
