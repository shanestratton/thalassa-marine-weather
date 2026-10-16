# Build138 currents: staged implementation

This source checkpoint adds a strict public forecast DTO and pure sampler. It does not activate a new provider feed. The released thirteen-frame CMEMS display namespace and its byte limits remain unchanged. The current regional routing loader and publisher are separate follow-up checkpoints; no production data has been acquired or published for this work.

`services/weather/currentSeries.ts` validates model/run/generation/source hash, true east/north m/s basis, surface depth, actual UTC times, provider cadence, exact buffers and per-frame known masks. It caps a cohort at eight tiles, 4096 cells per tile, 121 steps and8MiB decoded vectors/masks. Ocean coverage is at most120h and tide at most72h. Unknown cells remain unknown; finite zero is valid. Sampling uses nonzero spatial/temporal weights, so an irrelevant masked NaN cannot corrupt an exact known endpoint. It never clamps time or space.

The offshore adapter converts the same u/v sample to speed in knots and a true bearing **toward** which the current flows. The inshore adapter keeps u/v m/s and the existing **ETA-only** contract. Coarse currents do not establish a safe channel, depth, chart datum or clearance. Later-leg environments rebase currents, waves and exclusions together, including nested legs, while preserving forecast timestamps. The Worker boundary reconstructs only the public fields; it rejects a mixed legacy snapshot and forecast.

The legacy pure THCU sampler also rejects malformed explicit time axes and avoids zero-weight NaN reads. The existing no-network routing hold remains closed. Legacy snapshots retain their existing, explicitly snapshot-only treatment.

## Provider and activation limits

The current [Copernicus product manual](https://documentation.marine.copernicus.eu/PUM/CMEMS-GLO-PUM-001-024.pdf) separates ocean `uo/vo`, tidal `utide/vtide` and Stokes components. This roadmap requires ocean plus tide, without Stokes. The exact dataset/version and returned component coverage need a bounded source proof. Attribution follows the [Copernicus guide](https://help.marine.copernicus.eu/en/articles/4444611-citing-copernicus-marine-products-and-services); the exact licence page returned403 during review, so new routing-data redistribution remains held pending terms verification.

The [RTOFS inventory](https://www.nco.ncep.noaa.gov/pmb/products/rtofs/) describes three-hour global surface NetCDF, while [NOMADS](https://nomads.ncep.noaa.gov/) advertises HTTPS without a RTOFS spatial filter. No current-run data/header was acquired. Its actual time axis, depth, missing mask, curvilinear coordinates, vector rotation and component basis must be verified before enabling it. The source contract can represent a verified three-hour series; that is not a claim that a working bounded provider subset already exists.

[NOAA current predictions](https://api.tidesandcurrents.noaa.gov/api/prod/) are distinct from tide heights. Preserve station/bin/depth, flood/ebb direction and actual times; metric speeds are cm/s. Subordinate current stations provide max/slack predictions, not a continuous curve. A point station does not establish an arbitrary radius of routing coverage. NOAA station UI/coverage and model-tide activation are not complete in this first checkpoint.

## Verification

`CurrentSeries138`, `cmemsCurrentField`, `IsochroneEnvironment`, `offshoreComparison134` and `OffshoreSelection134` pass68 focused tests. These use generated public fixtures, including an actual shared-kernel run whose ETA changes under the supplied current. They cover invalid/missing axes, masks, NaN/zero endpoints, three-hour interpolation, the180-degree seam, nested leg clocks, Worker input privacy and the existing global-download hold. Scoped ESLint and formatting pass. Whole app/native compilation, configured production size and real regional asset proof are pending composition.
