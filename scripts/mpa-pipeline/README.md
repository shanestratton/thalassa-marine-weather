# MPA Pipeline — Australian Marine Protected Areas → GeoJSON

Fetches the Commonwealth + State marine reserves from the DCCEEW
[CAPAD](https://www.dcceew.gov.au/environment/land/nrs/science/capad)
FeatureServer, normalises the attributes, and ships a single
`mpa.geojson` file to a rolling GitHub Release that the Mapbox
client loads through the Vercel edge proxy.

## Why CAPAD

CAPAD is the canonical, government-maintained registry of all
Australian marine reserves. It refreshes at minimum twice a year,
covers Commonwealth and State jurisdictions, and is published under
CC BY 4.0 — perfect for a commercial app.

## Why GeoJSON (and not PMTiles)

Mapbox-GL v3 removed `addProtocol`, breaking the easy MapLibre-style
PMTiles bridge. Until we write a Mapbox CustomSource adapter, GeoJSON
is the lowest-friction shipping format. CAPAD's full marine slice
weighs ~2 MB after geometry simplification + gzip — fine as a one-shot
fetch when the user toggles MPA on for the first time.

## Restriction buckets

CAPAD's TYPE / IUCN / ZONE_TYPE attributes are noisy. The pipeline
collapses them into 3 user-facing buckets:

- **`no_take`** — sanctuary zones, marine national parks, IUCN Ia/Ib/II.
  Fishing, anchoring, collecting all banned.
- **`partial`** — habitat protection, conservation zones, IUCN III/IV.
  Some restrictions; check local rules.
- **`general`** — multiple-use, recreational-use, IPA Sea Country
  without specific zoning. Recreational fishing usually allowed.

The frontend colours each bucket distinctly so users see at-a-glance
"can I drop a line here?".

## Running locally

```bash
cd scripts/mpa-pipeline
pip install -r requirements.txt

# Just fetch + write GeoJSON (no tippecanoe / upload):
python -c 'import pipeline; fc = pipeline.fetch_capad_marine(); print(len(fc["features"]))'

# Full run (needs GH_TOKEN + GITHUB_REPOSITORY):
GITHUB_REPOSITORY=shanestratton/thalassa-marine-weather \
GH_TOKEN=$(gh auth token) \
python pipeline.py
```

## CI

Runs weekly via `.github/workflows/mpa-pipeline.yml`. CAPAD only
updates ~twice a year so weekly is plenty — the cheap polling keeps
the rolling release fresh in case of off-cycle corrections.
