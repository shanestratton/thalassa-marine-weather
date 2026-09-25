# Queensland marine place names — source and licence

`marine-place-names-qld.json` is a deliberately small, bundled subset of the
Queensland Place Names Gazetteer. It contains only current islands, bays,
coves, harbours and anchorages for proximity-based display labels.

- Source: State of Queensland, Queensland Place Names Gazetteer
- Original service: <https://spatial-gis.information.qld.gov.au/arcgis/rest/services/Location/QldPlaceNames/MapServer/1/query>
- Dataset catalogue: <https://www.data.qld.gov.au/dataset/place-names-gazetteer-queensland>
- Licence: [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/)
- Service attribution: © State of Queensland (Department of Resources) 2024
- Retrieved: 25 September 2026

The refresh query covers all Queensland records and explicitly requires
`status = 'Y'`, `currency = 'Y'` and source type `IS`, `BAY`, `COVE`, `HBR` or
`ANCH`. Former/absent feature types such as `ISX` are not included. The source
geometry is GDA2020 (EPSG:7844); the request uses `outSR=4326`, and the bundled
coordinates come from that transformed point geometry. Each `id` preserves the
source reference as `qld-place-name:<ref_no>`.

At this retrieval the query returns 1,207 records. Nine stable source references
are repeated at identical coordinates under separate ArcGIS object IDs (11
duplicate rows in total), so the script verifies and collapses only those exact
duplicates. The bundled 1,196 unique places comprise 891 islands, 266 bays, 27
harbours and 12 anchorages. The service currently returns no `COVE` rows; the
refresh script retains the mapping so any future current `COVE` records are
handled without broadening the selected feature classes.

Refresh with Node 24 or later:

```sh
node scripts/refresh-marine-place-names-qld.mjs
node scripts/refresh-marine-place-names-qld.mjs --check
```

The script verifies the live CC BY 4.0 licence, required schema, GDA2020 source
reference, eligible count, complete object-ID set, paginated result set and
duplicate-free source references before writing.

This gazetteer is not a navigation product. Its points are label locations, not
feature boundaries, harbour limits, surveyed anchorages or evidence of safe
water, depth, access or shelter. Always use current official charts, Notices to
Mariners and local conditions for navigation.
