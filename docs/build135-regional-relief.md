# Build 135 regional relief source checkpoint

This checkpoint adds a reviewed-source build path and a common display-region
registry. New regional datasets remain unpublished and inactive in the app.
The existing global and Great Barrier Reef rows remain the only active rows.
An AU-only full generation is running in isolated weather-volume staging; its
completion, output inventory and publication review are separate evidence.
The approved LINZ61-source generation has completed local raster/metadata
verification; neither is a published layer. No R2 write or timer is part of this checkpoint.

## Navigation boundary

Regional terrain is an illustrative base map. It does not supply soundings,
clearance, routing, tide corrections or alarms. `BathymetryCache` still uses the
existing `gebco-depth` service. No regional tile URL enters its acquisition path.
The registry is shared by Mapbox bounds/credits/reload, offline area planning and
the app-owned terrain filename validator. An unpublished provider, unsupported
zoom, wrong generation or tile outside the provider footprint is rejected.
Sparse generations additionally carry exact `[zoom,y,firstX,lastX]` row runs,
emitted only for tiles containing finite source seafloor. The bounded parser
rejects overlaps, adjacent unmerged runs, changed identity, invalid coordinates
and count mismatches. The saved-area planner intersects those runs before its
tile allocation/count limit, so expected holes are omitted and global relief
remains available. The same runs validate individual tile URLs and owned files.
No manifest fetch lane or new registry row has been enabled.

A future publication needs an exact verified generation before its registry row
can be added. Provider credits and original vertical datum belong to that row.
NAD83/PRVD02 and NAVD88 heights must never be relabelled MSL. The renderer uses
horizontal reprojection with `-novshift` and refuses ballpark transforms.

## Exact acquired public sources

| Source                                                                                                                                                                         |      Acquired bytes | Native grid and datum                              | Licence and coverage                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------: | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [GA AusBathyTopo Australia 2026 250m, eCat151280](https://pid.geoscience.gov.au/dataset/ga/151280)                                                                             |   2,380,292,468 ZIP | 32,001 × 20,799; WGS84; approximately MSL          | CC BY 4.0, Commonwealth of Australia / Geoscience Australia. Nominal 250m composite grid, not a claim of uniform survey resolution. Source bounds 92–172°E, 60–8°S. Not for navigation. |
| [CIRES / NOAA CUDEM Puerto Rico tile 2022v2](https://chs.coast.noaa.gov/htdata/raster5/elevation/NCEI_ninth_Topobathy_PuertoRico_9525/cudem_ninth_pr_m9525_met_forHumans.html) | 141,980,462 GeoTIFF | 8,112 × 8,112; NAD83 / PRVD02 metres; NoData −9999 | Public US government data; cite CIRES / NOAA, DOI 10.25921/ds9v-ky35. One actual approximately 0.25° tile, not whole Caribbean coverage. Not for navigation.                            |

The GA source is the current 2026 product, with its own reviewed
[official catalogue metadata](https://ecat.ga.gov.au/geonetwork/srv/api/records/7ff1f558-8ef4-427b-9696-007b76aab2c6/formatters/xml).
Its licence/lineage must not be inferred from the older GBR 2020 product.

Pinned SHA256 values are in `tools/relief/regional_sources.py`:

```text
GA ZIP     4f1409ce9edcd451a850611791c300eeb383d905ce48fa1823a9b8ca5e6ddec6
GA height  105e3fa5db779f3d37f37451305fc66ba2bcf491918f07f3875bd9efe304baea
NOAA TIFF  deb1f434565c3da06fead1af9d629f5defb3da5cc26bff92ea132bebda5d8c12
PROJ grid  a6db010f956526a011ba719c45fe32e5aff987eeb1cb03f2b8338208a77c619d
```

The 3,644-byte `us_noaa_pvhpgn.tif` is a separately pinned horizontal-transform
dependency from the official PROJ CDN. Its
[PROJ-data licence record](https://github.com/OSGeo/PROJ-data/blob/master/copyright_and_licenses.csv)
marks it public domain. It is mounted locally; conversion has no network access.

## Bounded acquisition and actual raster proof

`regional_sources.py plan` prints a no-op plan. `acquire-proof` is restricted to
`/srv/weather/thalassa-relief135-proof`, exact source URLs, status, MIME, lengths
and hashes. It limits total compressed inputs to 4GB, expanded inputs to 12GB,
requires a 20GB disk reserve and uses sequential downloads (at most two allowed).
ZIP paths, duplicate members, symlinks, encryption and expansion are validated.
Partial files are retained for review rather than silently overwritten.

The GDAL runtime is the existing pinned image, without package installation:

```text
sha256:57b20fcd82df868582b1a024f7b00f181e0614950b7a7046b02a5d5cd3c2bb2e
```

The proof renderer creates only a 2×2 tile block per provider, with DEM WebP,
depth-colour index PNG and a separate finite-source QA mask. The actual GA/NOAA
rasters have been decoded in this container. The Puerto Rico proof deliberately
crosses the raster's west boundary and demonstrates real missing-source pixels
falling back to the existing coarse GEBCO grid. Unknown water with no valid
regional or coarse value fails closed. Land is explicitly masked. The final
renderer refactor has six container tests; its exact tiny-proof receipts will be
refreshed after the single-worker AU run, without running a second GDAL worker.

Each proof recipe records input, builder, renderer, acquisition helper, encoder
and container identities. Provider NoData values and coverage masks remain
explicit. Existing `encode_tiles.py`, GEBCO and OSM inputs are reused unchanged.
The terrain remains a mixture of source-resolution data and coarse fallback;
tile zoom does not imply a new measurement resolution.

## Approved AU-only full build

`regional_plan.py` performs arithmetic only. The separately reviewed AU job uses
the already verified input, bounds 92–172°E / 60–8°S and zooms 8–10. It allows at
most 116,388 DEM/index objects, 4GB final output and 16GB expanded-plus-output
workspace. The broader multi-region proposal is not permission to build or
publish those other regions.

`build_au250.py` defaults to a no-op plan. `--build` is restricted to
`/srv/weather/thalassa-relief135-build`; it takes a nonblocking lock, verifies the
source receipt and extracted raster hash, and rejects a changed recipe. It uses
one GDAL process, one CPU, a 1GB Docker memory limit and no network. It writes
atomically within that workspace, enforces the peak byte cap before writes,
retains per-block hashes and can resume only verified matching checkpoints.
Coverage sidecars are local QA, included in the byte cap, not additional proposed
R2 objects. No source file or completed output is recursively deleted.

The intended output is `v2/relief-au250/{dem,idx}/z/x/y` plus a provider-labelled
local manifest. All manifests explicitly say `published: false`. No R2 upload,
server, DNS, public manifest, systemd unit or timer is part of these tools.
Publication still requires complete output validation, source credits, masks,
seam checks and an exact immutable-generation/manifest-last plan. Until then the
app continues to use its existing published global/GBR relief.

## Other regional inventory and holds

The original New Zealand inventory entry below is superseded by actual public
LINZ data: [LDS122508](https://data.linz.govt.nz/layer/122508-new-zealand-coastal-lidar-1m-dem/)
and the [LINZ-owned AWS dataset](https://registry.opendata.aws/nz-coastal/).
The pinned collection, updated2026-10-15T17:04:29Z, contains61 surveyed coastal
patches,4,111,183,760 B total COGs; all were acquired with exact length/SHA checks,
reusing the existing19,947,427 B AU26 source. CC BY4.0 attribution and the access
date must be retained. Native heights are NZVD2016 metres, never relabelled MSL.
The actual AU26 tiny proof contains94,717 finite source seafloor pixels and
130,213 explicit coarse-fallback pixels across four tile pairs. That proof does
not establish whole-NZ coverage.

`nz_coastal.py` defaults to a no-op over the separately reviewed plan SHA
`80031d2dddcdc54e2fbf2d2bd93492cd83278f7abad547355e0ae0c232069f16`.
Its explicit runner uses two fixed-source download lanes,5GB input,10GB workspace,
2GB output and a two-hour parent deadline, with20GB weather-volume reserve.
One network-disabled pinned GDAL worker has one CPU/1GB memory,32MB GDAL cache
and64MB warp memory. Sources are processed sequentially through explicit
overviews and clipped native ROIs; aggregate regional decoded ROI is capped
at256MB per output block. Every source's actual CRS, Float32 packing, metre
geotransform, NoData, scale/offset, overview sizes and finite overview pixels is
recorded, with its exact source checksum. Mismatches stop processing.

Preflight corrected one real planning issue without changing the original plan:
some z8 blocks intersect16 COGs and z9 blocks10. A reviewed recursive subdivision
now limits each source-read subwindow to eight COGs, then assembles the same
512px output block before a single source-mask/GEBCO feather blend. No input is
dropped. A deterministic16-grid pixel/seam regression and an actual pinned-GDAL
overview/ROI/NoData test pass. Checkpoints verify recipe/output hashes; failed
or partial files remain available for review. The two-hour invocation is not
silently extended by checkpoint support.

Output is bounded to the union of those61 actual footprints and finite source
water, z8–14; the46,886 DEM/index object count is an upper bound, not a completed
coverage claim. QA masks remain local. Completed manifests must carry exact
emitted availability, source/renderer identities, provider datum/credits and
`published:false`. Existing global/GBR rows remain unchanged until a separate
public-generation review.

The actual NZ result contains2,197 tile pairs (4,394 DEM/index objects), across
724 exact row runs in15,362 B. All6,425 source-footprint blocks and6,591 images
were hash/length checked; every image was decoded, and binary mask pixel totals
match checkpoints. Retained raster/checkpoint output is21,244,703 B. Actual
source holes therefore reduce coverage substantially below the46,886-object
footprint upper bound; the result must not be labelled whole-NZ coverage.
The real availability fixture passes the app parser and saved-area consumer;
its4,394-object whole-set plan correctly exceeds the4,096-tile phone limit,
while a clipped area plans only existing pairs.

The raster invocation's final metadata step failed because the first row-run
implementation accepted tuple fixtures but JSON checkpoints contain lists.
The failed log and exact original runtime source/recipe remain retained.
After the list-format regression was fixed, `nz_finalize.py` verified every
original checkpoint, source SHA, decoded ROI/input-count limit and tile/mask
hash. A separate network-disabled worker mounted all originals read-only and
wrote only a new `review-final` metadata directory; no source or tile was
redownloaded, rerendered or changed. Its manifest also extracts the actual
collection issuance timestamp, rather than putting a descriptive title in a
timestamp field. Future builder recipes include all imported implementation
file hashes, so a changed implementation cannot silently resume old work.

Review evidence (outside Git): `work/relief135-nz61-result`.
Manifest SHA256 is
`922ae0ac5678e58804d7bc5d9f1c76f9e0d7db54b53cbc22446ca8eecb39d3a5`;
availability SHA256 is
`edf5227268b360cf5f195d4b477e0779faf42da9001ce9bd7fd254effdb2f08b`.
The original frozen raster recipe is
`41886b7a0e8fee743c86dcd491a0af46ba7d7c6f0595a249ac1f439714c1bc22`.

New metadata-only US research has also identified the official
[CUDEM1/3 collection](https://coast.noaa.gov/htdata/raster2/elevation/NCEI_third_Topobathy_2014_8580/):
357 actual STAC raster footprints in12 regions, NAD83/NAVD88 metres and NoData
−999999; its whole download is advertised8.0G. The
[CUDEM1/9 collection](https://coast.noaa.gov/htdata/raster2/elevation/NCEI_ninth_Topobathy_2014_8483/)
is advertised176G, so whole-set acquisition is excluded. The California regional
listing alone is7.1G. No new US raster was acquired from those inventories.
EMODnet's actual ERDDAP metadata exposes a72,000×75,840 DTM2024 grid and separate
value-count/CDI/interpolation grids. A21.84GB single-float full-grid request is
excluded; a concrete small official subset and its source-quality mask/terms
still need review. A provider index or GEBCO-filled cell is not new survey detail.

| Region      | Exact current knowledge                                                                                                                                                                                                                        | Remaining acquisition/publication hold                                                                                                                                                                                                                                                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Europe      | [EMODnet DTM 2024](https://doi.org/10.12770/cf51df64-56f9-4a99-b1aa-36b8d7b743a1), nominal approximately 115m, LAT; a separate MSL variant exists. Official ERDDAP metadata exposes the European grid.                                         | Select real tiles, pin their dataset terms/footprints and preserve non-GEBCO/source-quality coverage. No whole proposed European rectangle has been downloaded. EU-derived products are CC BY 4.0 by default under [EMODnet terms](https://emodnet.ec.europa.eu/en/terms-use-emodnet-online-services-data-and-data-products); underlying survey restrictions still need checking. |
| US coast    | [NOAA CUDEM](https://www.ncei.noaa.gov/products/coastal-elevation-models) has public regional collections, with dataset-specific footprints and vertical datums.                                                                               | Inventory actual current raster footprints and bytes. CONUS NAVD88, Puerto Rico PRVD02 and Hawaii MSL are distinct. A single Puerto Rico proof cannot establish US/Caribbean-wide coverage.                                                                                                                                                                                       |
| New Zealand | [LINZ hydrographic data](https://www.linz.govt.nz/products-services/data/types-linz-data/hydrographic-data) includes bathymetry indexes and request-based source data; selected 3D Coastal Mapping rasters may provide open regional coverage. | No reviewed downloadable whole-NZ raster exists in this checkpoint. An index is not a height grid. Identify an actual raster, licence, datum and footprint before a regional build. No data-request email was sent.                                                                                                                                                               |

The no-op multi-region plan leaves unknown US/NZ footprints unresolved and reports them as
unresolved rather than filling a country rectangle with misleading detail.
Its coarse gross R2 cost ceilings exclude shared free allowances and future
request traffic: 30GB storage is $0.45/month, with up to $9 initial Class A writes
at whole-million billing increments under [current R2 prices](https://developers.cloudflare.com/r2/pricing/).
Those are proposal ceilings, not measured AU costs or an activation decision.

## Validation at source checkpoint

- Shared app TypeScript passed after registry integration; no outstanding relief types.
- Three new registry/navigation-boundary tests and 80 existing relief/storage/style tests passed.
- Thirteen portable source/archive/planning tests passed.
- Six builder budget/NoData tests passed inside the pinned GDAL container.
- Owned app lint and formatting passed. Exact full-generation completion and
  refreshed final tiny-proof receipts remain runtime evidence to collect.

Reproducible no-op commands:

```sh
python3 tools/relief/regional_sources.py plan
python3 tools/relief/regional_plan.py --region au250 --region eu --region pr --region us --region nz
python3 tools/relief/build_au250.py
python3 -m unittest discover -s tools/relief -p 'test_regional_*.py' -v
```
