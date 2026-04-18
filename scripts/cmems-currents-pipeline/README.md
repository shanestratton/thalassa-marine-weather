# CMEMS Ocean-Currents Pipeline

Daily job that pulls Copernicus Marine surface currents and publishes them to
Mapbox Tiling Service as a `raster-array` tileset, which the Thalassa map
consumes via the native `raster-particle` layer.

## Data source

- Product: `GLOBAL_ANALYSISFORECAST_PHY_001_024`
- Dataset: `cmems_mod_glo_phy-cur_anfc_0.083deg_PT1H-i`
- Resolution: 1/12° (~8 km), hourly
- Horizon: 48-hour forecast (configurable in `pipeline.py`)
- Variables: `uo` (east velocity, m/s) + `vo` (north velocity, m/s) at surface

## Attribution (required by CMEMS licence)

The Thalassa UI must display, whenever this layer is visible:

> Currents: E.U. Copernicus Marine Service Information
> DOI: `10.48670/moi-00016`
> © Mercator Ocean International

## Running locally

```bash
cd scripts/cmems-currents-pipeline
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
pip install mapbox-tilesets  # the `tilesets` CLI

export COPERNICUS_MARINE_USERNAME=...
export COPERNICUS_MARINE_PASSWORD=...
export MAPBOX_UPLOAD_TOKEN=sk....
export MAPBOX_USERNAME=shanestratton

python pipeline.py
```

## CI

See `.github/workflows/cmems-currents-pipeline.yml` — runs daily at 06:00 UTC
(1h after CMEMS's nominal forecast-release time).

## Tileset layout

One tileset per forecast hour, to keep each MTS job bounded:

- `shanestratton.thalassa-currents-h00` — nowcast
- `shanestratton.thalassa-currents-h01` — +1h
- …
- `shanestratton.thalassa-currents-h47` — +47h

The client scrubs forecast time by swapping the source URL.
