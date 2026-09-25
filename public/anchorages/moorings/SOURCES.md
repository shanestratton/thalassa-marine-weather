# Moorings reference

`qpws.json` is a snapshot of Queensland Parks and Wildlife Service public moorings,
retrieved on the timestamp embedded in the file. It is not an occupancy feed or a
guarantee that a buoy remains present, serviceable or suitable for a vessel.

Source: https://spatial-gis.information.qld.gov.au/arcgis/rest/services/Environment/ParksMarineMoorings/FeatureServer/20

Attribution: © State of Queensland (Department of Environment and Science) 2024.
The service's use limitation states that positions captured by GPS must not be
treated as definitive absolute mooring locations. WGS84 geometry is requested
from the service (`outSR=4326`), rather than relabelling its native datum.

Body colour (blue) comes from the dataset description. Class-band colours come
from Queensland's public-mooring guidance, not the colour of an OpenSeaMap icon:
https://www.qld.gov.au/environment/coasts-waterways/marine-parks/public-moorings-reef-protection-areas

No vessel-length/wind/tidal-clearance approval is inferred. Always read the buoy
tag and current official conditions. White reef-protection markers with blue
labels are not moorings. Private moorings require the owner's permission.

Refresh manually with `node scripts/anchorages/refresh-moorings.mjs`. The script
rejects error/truncated results and atomically replaces the previous snapshot.
No scheduled task is enabled by this feature.

After refreshing, run `node scripts/anchorages/build-mooring-shelter.mjs`.
`shelter.json` is derived from the existing QLD OSM coastline cache, with the
source timestamps included. 36 rays at each actual mooring position measure
coastline fetch out to 15 NM; the snapshot and coordinates must match exactly.
Missing source data stays unknown. Reefs are deliberately not treated as reliable
wave barriers at all tides. These are approximate geometry-based exposure
estimates, not a hydrodynamic model or verified safe mooring assessments.

Traffic lights are a worst-hour forecast screening for the next 12 hours.
Green means favourable modelled weather/exposure, not permission or clearance.
Missing/stale weather, incomplete windows, shelter or mooring/vessel limits
cannot produce green. QPWS class C uses the conservative 24 kn limit to include
the Moreton Bay exception. Gusts are also screened against the limit, deliberately
more conservative than using mean wind alone. Check the physical tag.
Depth, tides, holding, swing room, local acceleration, actual mooring condition
and current official warnings are not automatically cleared by these colours.

Worldwide supplemental references are © OpenStreetMap contributors, ODbL:
https://www.openstreetmap.org/copyright
They are queried on demand in bounded one-degree cells, with a bounded on-device
cache. Coverage and colour/access tags vary; no completeness claim is made.
Failed or partial queries are not cached as an empty successful response. Unknown
colours and permissions remain unknown. Way/relation centres are approximate
references, not individual buoy or safe anchor-drop positions. Moorings, piles,
bollards, reef markers and anchorages are not interchangeable.
