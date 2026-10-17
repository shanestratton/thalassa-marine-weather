#135-05 /135-08 public marine catalogues

Status: app path and build/plan tools implemented. The reviewed worldwide GeoNames source has been downloaded into isolated wx staging; its first build exposed a dense Finnish cell and was stopped without truncation. Adaptive area refinement is being validated against that saved source. **No dataset has been uploaded, activated or represented as deployed.** Existing Queensland atlas and place-label fallback remain usable until the first reviewed global publication. No database migration is required: these are credential-free static objects.

## Source boundaries verified16 October2026

- [GeoNames dump README](https://download.geonames.org/export/dump/readme.txt): CC BY4.0, stable geonameid,19-column UTF-8 TSV. [Feature codes](https://www.geonames.org/export/codes.html) supply a narrow marine selection. Names, source IDs and up to16 aliases are adapted into spatial and name-prefix shards. Keep this database separate from OSM; the later142-07 place-name merge is not implemented here.
- [OSM copyright](https://www.openstreetmap.org/copyright): credit contributors and offer the adapted database under ODbL. [Geofabrik downloads](https://download.geofabrik.de/) provide regional public extracts; no global Overpass query. Publish the **entire adapted OSM database** as downloadable area shards with LICENCE.txt and SOURCE.json. GeoNames remains a separate database. Preserve original node/way/relation IDs; never use names or coordinates as identities.
- [NOAA ENC Direct to GIS](https://nauticalcharts.noaa.gov/data/gis-data-and-services.html) supports public feature extraction. The specific [NOAA ENC user agreement](https://charts.noaa.gov/ENCs/ENC_Agreement.shtml) applies to these derived records: present and accept its complete text, preserve the NOAA origin link, and label redistribution as derived reference data, not official/certified ENC or carriage-compliant charts. The exact bundled agreement text is versioned by SHA256 `175f625ba0ae7b8656bf41010d6e5226b70f66a5a5c00ceff450c2eba2411c24`; app acceptance is account-scoped. Before NOAA acquisition, the wrapper verifies the reviewed government HTML hash and stops if it changes. The manifest carries the accepted-text hash; an app with different terms withholds the dataset, including cached records. [Coast Survey licensing](https://nauticalcharts.noaa.gov/data/data-licensing.html) also distinguishes externally contributed data: review the actual public-source metadata and exclude restricted contributions. The tool admits only ACHARE/ACHBRT and original16-hex LNAM. RCID/OBJECTID alone is refused.

The publisher never reads a device, chart vault, purchased ENC, customer chart upload, user table, sounding, track, boat position or API key. App records are strict allowlists of public representative points, names and reported restrictions. No depth/clearance claim is inferred. Areas/polygons get approximate centres with date-line unwrapping, not guaranteed interior/water points. Protection marks, piles and bollards are not pickup buoys. Nearby distinct moorings stay distinct. NOAA and OSM IDs remain separate even when two sources describe the same place: do not silently discard a future140-02 note identity.

## Objects / app behavior

Owned prefix only: `https://tiles.thalassatiles.com/marine-catalogue/v1/`.

```
places/manifest.json
places/<generation>/areas/<lat-index>_<lon-index>[-<quadrants>].json
places/<generation>/names/<unicode-prefix-in-hex>.json
osm/manifest.json
osm/<generation>/areas/<lat-index>_<lon-index>[-<quadrants>].json
noaa/manifest.json
noaa/<generation>/areas/<lat-index>_<lon-index>[-<quadrants>].json
```

Each dataset is independently published; failure in one cannot promote another dataset's manifest. Generations are immutable `<YYYYMM>-<hash-of-input-manifest-and-build-policy>`. Including the build policy prevents a changed shard partition from reusing an earlier immutable identity. The monthly job must retain the current generation while its successor uploads, then atomically replace only that dataset's manifest last. Manifest identity is checked on every shard. Source URLs, licence, time, IDs, coordinate range, keys, byte count and records are validated. Unexpected fields are rejected before persistence.

Glass →★→Marine places searches after Submit and at least three letters; ambiguous results rank by local distance, with country/location labels. Dense prefixes split into longer leaves, up to24 letters, without dropping records. A query reads at most four matching leaves; wider matches ask for a longer name. Boat coordinates stay local. The CDN sees public prefix IDs or public spatial shard IDs, never exact boat coordinates. Dense two-degree root cells split into nonempty quadtree leaves, at most eight levels (SW=0, SE=1, NW=2, NE=3), without dropping records. Spot actions explicitly open the existing sea-cell Glass forecast, nearby observations, informational tide stations or save the exact public point. No forecast is automatically queried by opening search. Tide/observation adapters retain their existing freshness, permission and missing-data policies.

Read/save shown area selects at most 16 two-degree root cells within 50 NM, then reads at most 16 published leaves per source with a 10000-record operation ceiling. When a dense area has more leaves, local distance prioritizes the reads and the result explicitly remains incomplete; it cannot claim the whole area is saved. Wide polar fan-outs are refused. Individual JSON objects ≤2MiB,10k rows, two in flight, a16-request queue and15-second request deadline. A three-source area has a hard maximum of48 shard requests plus three manifests; it can exceed cache capacity, so completion is checked against all required persisted objects after eviction. No query at phone boot. Outside the richer bundled QLD atlas, public anchorage points augment existing layers; no absent fetch table becomes a favourable shelter verdict. The existing small bounded Overpass mooring query remains a fallback while a published extract is unavailable, and is suppressed in Satellite Mode. It is not used by place-name search.

Public data cache: serialized writes, at most96 entries /24MiB **including serialized pack overhead**, native Directory.Data or one IndexedDB record on web. A cold process validates its pack and records. Oldest downloaded objects are evicted (not an indefinitely pinned full-area promise). A large/partially available area is explicitly incomplete; users should test the saved area offline before departure. Satellite Mode is cache-only, including explicit area requests. Delete fences in-flight operations and clears the pack; the service worker bypasses this exact prefix, avoiding a second stale copy in the terrain cache. Purchased-chart persistence rules are unchanged.

## Local build recipe (no network / publication)

Prepare a dedicated reviewed input directory. Never point it at the app's native chart storage. Place the public GeoNames TSV or one-GeoJSON-feature-per-line OSM/NOAA extraction there. Only the source parser's allowlisted fields survive. Input names are relative paths; absolute paths, traversal, symlinks and unexpected metadata are refused. Hashes must describe the local extracted inputs, with original public source URLs and actual acquisition date recorded separately by the operator.

Example reviewed input manifest (replace all fixture values with actual reviewed values):

```json
{
    "schema": 1,
    "dataset": "places",
    "licence": "https://creativecommons.org/licenses/by/4.0/",
    "coverage": "GeoNames selected marine feature classes worldwide; incomplete community gazetteer",
    "sourceAt": "2026-10-16T00:00:00Z",
    "inputs": [
        {
            "path": "allCountries.txt",
            "sourceUrl": "https://download.geonames.org/export/dump/allCountries.zip",
            "bytes": 123,
            "sha256": "replace-with-64-lowercase-hex-characters"
        }
    ]
}
```

```sh
python3 scripts/marine-catalogue/build.py --input-manifest /srv/thalassa-catalogue/input/places.json --output /srv/thalassa-catalogue/staged
python3 scripts/marine-catalogue/publication.py --generation /srv/thalassa-catalogue/staged/places/GENERATION --inventory /srv/thalassa-catalogue/review/r2-owned-inventory.json --current /srv/thalassa-catalogue/review/current-places.json > /srv/thalassa-catalogue/review/places-plan.json
python3 -m unittest discover -s scripts/marine-catalogue -p 'test_*.py'
```

`build.py` performs no requests. It streams GeoNames TSV and GeoJSON lines through SQLite (16MiB page cache,2GiB scratch limit), ≤32 input files each≤8GiB,≤2M admitted records,≤8MiB input line,≤2GiB output. Dense name and spatial shards subdivide; an unsplittable name or exact-location group exceeding its row/byte cap fails the entire generation rather than dropping records. Empty/all-source-failure builds cannot create or replace an active manifest. Existing immutable generations are reused. The complete inventory (≤50000 keys,≤2MiB manifest) distinguishes a known-empty cell from a missing listed object.

OSM extraction preparation on wx (review available disk/region scope first): use installed `osmium tags-filter` on **public Geofabrik PBFs only**, retaining `nwr/seamark:type=anchorage,anchor_berth,mooring`, `nwr/mooring=buoy`, `nwr/seamark:buoy_special_purpose:category=mooring`, `nwr/anchorage=yes`; export with `osmium export --attributes=type,id -f geojsonseq`. Convert the RFC8142 record separators to newline-delimited JSON in the controlled staging directory. The parser uses original @type plus @id; area-derived synthetic IDs never replace the original way/relation ID. Referenced nodes must remain available to osmium; do not drop dependencies. Never run a global Overpass query. Build AU first with honest coverage, then add reviewed world extracts; do not label an AU-only extract worldwide.

NOAA extraction preparation: use the135-06 official catalogue job's **ACTIVE-only immutable public source directory**, reviewed metadata and Python GDAL S57 extraction of **ACHARE/ACHBRT only**, including original LNAM/OBJNAM/restriction fields. `extract_noaa_cells` opens the S57 driver with `LNAM_REFS=ON`, admits absent object classes as empty cells, and aborts on actual read errors. Export one feature/line with class=ACHARE/ACHBRT. Do not upload whole charts. When an LNAM occurs in multiple NOAA cells, reviewed input order places the current, highest-detail cell last. Retain source snapshots/hashes in the operator's review record. The135-06 NOAA publisher should supply its immutable public source directory so the two jobs do not independently download the national collection. Actual current NOAA/GDAL extraction proof is pending that shared source run; generated fixtures do not substitute for it.

## Activation / monthly job review (not executed)

Independent NOAA acquisition through `acquire.py` is disabled: the held `noaa-us.plan.json` is reference material, not an executable national download. This prevents cancelled cells from entering an anchorage build through All_ENCs. The shared active-source handoff must be reviewed before NOAA catalogue publication.

The executable package comprises `acquire.py`, `monthly.py`, `publish.py`, fixed GeoNames/AU-OSM/world-OSM plans and a preparation-only systemd service/timer. No new wx timer has been installed. First review the exact source-plan hash and available disk/quota; acquire a small AU extract, inspect its real parser output/counts and licence metadata, then review the resulting publication plan. No source job runs on a phone. Existing weather jobs and their credentials remain separate.

`acquire.py` defaults to a no-network dry run. Execution requires `--execute --plan-sha256 EXACT_HASH`. It streams and hashes fixed public URLs, refuses redirects, bounds bytes/time/ZIP expansion, strips all nonallowlisted output fields, and records receipts. Source plans have at most eight objects,≤64GiB/object,≤128GiB whole transport and≤24GiB whole extracted data. The initial AU plan is2GiB transport/2GiB extracted. The separately reviewed world OSM plan covers the eight continental Geofabrik extracts: current public listing is approximately80GB raw, not a small refresh. Its caps total114.25GiB transport/14.125GiB extracted. No continental file has been fetched here. Disk admission reserves all raw and three intermediate/extracted budgets plus4GiB. Linux osmium children also have an RLIMIT_FSIZE cap for intermediate files. A dedicated filesystem quota is still required for the complete job.

The supplied preparation service uses a nonroot dedicated account, shared OS lock,6-hour deadline,2GiB RAM, low CPU/IO priority and8GiB per-file cap. That default is suitable for reviewing AU, GeoNames or NOAA plans; **a world OSM run needs a separately reviewed64GiB per-file service override, measured run-time and disk/bandwidth review**. Do not silently reuse AU resource assumptions for Europe/North America. Use separate, staggered dataset instances sharing `/srv/thalassa-catalogue/refresh.lock`; one successful dataset does not imply another is global/current.

Preparation and publication dry-run commands (replace placeholders with reviewed paths/hashes; these are not run by installation):

```sh
python3 scripts/marine-catalogue/monthly.py --plan scripts/marine-catalogue/osm-au.plan.json --root /srv/thalassa-catalogue
python3 scripts/marine-catalogue/monthly.py --plan /etc/thalassa/osm-au.plan.json --root /srv/thalassa-catalogue --execute --plan-sha256 EXACT_SOURCE_PLAN_SHA256
python3 scripts/marine-catalogue/publish.py --generation /srv/thalassa-catalogue/staged/osm/GENERATION --review-plan /srv/thalassa-catalogue/osm-review.json
```

The last command reads only the exact owned R2 prefix and writes a local review plan. Install server-only `requirements.txt` in a dedicated runtime; configure `CATALOGUE_R2_ACCOUNT_ID`, `CATALOGUE_R2_BUCKET`, `CATALOGUE_R2_ACCESS_KEY_ID`, `CATALOGUE_R2_SECRET_ACCESS_KEY` in the dedicated environment file. Never bundle these keys in the app. After root reviews the exact object list/hash, `publish.py --apply --plan-sha256 EXACT_REVIEW_PLAN_SHA256` can execute that plan; deletion remains off unless separately adding `--enable-retention`.

The exact publication plan from `publication.py` is read-only. The executable `publish.py` wrapper recomputes the reviewed inventory/paths/hashes, verifies actual bytes after every immutable object upload, rechecks the staged manifest, and refuses the pointer swap after any failed/partial upload. Conditional R2 PutObject uses `If-Match` on the reviewed ETag, or `If-None-Match:*` for first publication; a competing writer fails. Manifest Cache-Control≤12h; generation shards immutable. Serve JSON with application/json and CORS allowing app/browser reads; no credentials. Client redirect policy is error. **Do not enable publication with an arbitrary rsync --delete.**

Retention dry run: pass an actual listing of this exact owned prefix only, plus the actual current manifest. The plan protects the new generation, actual current generation and newest previous generation, refuses any outside-prefix key, and admits upload only when **all existing objects plus new missing objects and the pointer fit8GiB/dataset before cleanup**. Orphan/old objects count even if cleanup is disabled. Deletion candidates apply only after all object checks and a successful manifest swap, with an ETag read before each deletion; never delete current. Local cleanup is confined to exact generated directories. Without approved retention, source snapshots cap at two/dataset (each≤24GiB) and staged generations cap at three/dataset (each≤2GiB); the next run stops rather than grows.

Optional unattended monthly publication requires a second explicit policy file and its exact SHA256, passed using `--publication-policy PATH --policy-sha256 HASH`. Its exact fields must be:

```json
{
    "schema": 1,
    "sourcePlanSha256": "EXACT_SOURCE_PLAN_SHA256",
    "ownedPrefix": "marine-catalogue/v1/",
    "publication": true,
    "retention": true
}
```

This opt-in mode records each actual publication plan before uploading, keeps active-source proof, and performs only the bounded owned retention above. The supplied service does not pass these arguments. The first GeoNames acquisition was reviewed and executed in isolated /srv/weather staging. Publication, cleanup and timer activation remain held for root review of the exact generated plan; no deployed world dataset or active timer is claimed.

## Checks

`tests/MarineCatalogue.test.ts`, `tests/MarinePlacesSheet.test.tsx`, the added service-worker regression, Python generated fixtures and `browser-tests/marine-places-layout.spec.ts` exercise real schema/cache/UI paths. Browser tests are in the standard keyboard config (Chromium/WebKit), use fictional source records only, prove real IndexedDB cold restart/Satellite no-WAN/deletion, and check300/375px layout and attribution. No provider request contains a real boat position. No release budget is raised.

## Retained OSM duplicate normalization proof

The three reviewed 15 October 2026 extracts remain separate, unpublished cohorts. Revalidation found 2,364 unique original IDs and 308 equivalent duplicate exports: Oceania 2,107 IDs, Central America 229 and Antarctica 28. No new source was acquired, no cumulative manifest was built, and no R2 object, timer or production pointer was changed.

Four Central America closed ways (`179084944`, `830303041`, `830303042`, `1445268880`) were exported by osmium as both LineString and MultiPolygon. Their tags and full coordinate sets were identical, but rotated ring starts produced about 1e-14-degree longitude roundoff in the old calculation. The retained public fixture pins the original source URL/SHA and normalized-input SHA. Its eight features are ODbL source data, kept separate from other catalogue sources.

OSM representative points now use canonical validated vertices and one order-independent longitude base. This remains an approximate bounding-box midpoint, with no interior, water, clearance, access or anchor-drop claim. Repeated original IDs must have both an identical normalized record and an identical canonical vertex fingerprint. Changed vertices fail even if their midpoint is unchanged; changed names or positions fail as well. The build aborts atomically and preserves previous generations. It never picks the last OSM row. NOAA's separately reviewed highest-detail-cell ordering and GeoNames behavior are unchanged.

The OSM-only build-policy suffix `osm-vertex-order-independent-conflict-check1` generates new immutable generations rather than modifying earlier receipts. Retained-only offline revalidation used the same reviewed image `sha256:954d06674cb6b8307fb5596744250c88f5042180064e1626935d953f93ae6762`, no network, read-only inputs/code, one CPU, 2 GiB with no swap, 32 PIDs, 128 MiB temporary space and a 300-second deadline. It completed in 1.16 seconds with sampled cgroup peak 60,616,704 bytes and zero conflicts. The three outputs preserve every original ID:

| Cohort          | Generation                |   IDs | Objects |   Bytes | Manifest SHA256                                                    |
| --------------- | ------------------------- | ----: | ------: | ------: | ------------------------------------------------------------------ |
| Oceania         | `202610-1a58c58b0a514e05` | 2,107 |      77 | 480,394 | `d3066d1eae5ac8fa86d7715ce5841faf810abd8148da03b1c388c5d34febbffd` |
| Central America | `202610-e3605ec5ceb74d1c` |   229 |      26 |  54,363 | `a247e38eb9de9fa56e49f76b06ebbde80fed0cd4ae0412d4f522628d40035663` |
| Antarctica      | `202610-56ef11b130d5e292` |    28 |      13 |   8,674 | `fa3c2c22f09db76624512e0c4f3ccfb1f06721cd265de222ab20969a8e80d93e` |

All 33 local pipeline tests passed; all 14 build tests passed in that actual offline runtime. Revalidation receipt SHA256 is `daae02073a87510a60105ec4ea3daac2e0551ae915b4eea024af3e1bf6562f29`. Old source snapshots, generations and failure receipts remain intact. No global coverage is claimed; any later union must retain every reviewed cohort and refuse actual original-ID conflicts.
