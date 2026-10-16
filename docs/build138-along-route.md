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
proof. This document will record those steps once they are implemented.
