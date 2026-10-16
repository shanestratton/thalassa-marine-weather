# Build135-06 — official NOAA ENC catalogue

The app can select active NOAA cells for its current camera area, preserve the
unchanged official ZIP and install the verified shared-GDAL conversion into the
normal phone chart store. A Pi is not required. This is a Thalassa display of
NOAA data, not a certified ECDIS or a substitute for required charts.

The catalogue/publisher source is prepared. **R2 publication, global conversion
and the weekly server timer have not been activated.** Until that deployment is
reviewed and verified, the public download entry reports unavailable rather than
claiming coverage. Browser fixtures prove the end-to-end client with pinned
public data; they do not imply the public endpoint is live.

## Source and cancellation proof

- Official catalogue: https://charts.noaa.gov/ENCs/ENCProdCat_19115.xml
- Agreement/origin: https://charts.noaa.gov/ENCs/ENC_Agreement.shtml
- GDAL semantics: https://gdal.org/en/stable/drivers/vector/s57.html
- S57 cancellation semantics: https://docs.iho.int/iho_pubs/standard/S-57Ed3.1/20ApB1.pdf

The 2026-10-16 catalogue was 52,363,347B, SHA256
`61509e0c72439cbbf30e4dab12c1f223ad40cdf321cd564762734af3d38c0588`.
It normalizes to 7,114 active cells with coverage, 195 withdrawn/no-extent
records and 102 fixed 10-degree regional shards. Active ZIP sizes total 788,770,162B;
the largest listed active ZIP is 1,836,509B. Pacific longitudes deliberately
unwrapped beyond180 degrees are normalized; crossing cells retain dateline
coverage. Camera/boat coordinates are filtered locally and never sent to NOAA
or the catalogue host.

US5CA16M is **cancelled**, despite the catalogue retaining its 46.1 download:
base DSID 46u0, effective DSID after.001 is 0u1. The strict publisher refuses it.
The earlier 9-point GDAL check remains a historical geometry-retention proof,
not current/installable coverage. No-extent records never enter active shards.

The active proof is US5CA1LK, effective DSID edition 1/update 1, issued 2026-04-22:

- Original ZIP 26,403 B, SHA256
  `8a5138368863fbe33acae1be756e2c9135e0eeac32ca48a86eb0baf07b55e539`.
- Shared conversion 115,877 B, 98 features, SHA256
  `51d48a6cd5d445bde556023a0a4b6e95a88147e3ce755548c1dcf9eec88b1464`.
- SBDARE retains 27 Point features and 8 Polygon features. Updates were applied;
  the base was not substituted to force a desired edition.
- The final converter requires complete feature counts for each source layer
  in the independent ogrinfo inventory; failures cannot become empty navigation
  coverage. A source class absent from that inventory is genuinely absent.
- WEDKLP remains separate from NATSUR. Existing GDAL dictionaries identify
  class 158, Point/Area, CATWED 70: 1 kelp, 2 sea weed, 3 sea grass, 4 saragasso
  (dictionary spelling). It is not a crossing caution or routing input.

The isolated wx image is
`sha256:990dc0e63d9ce8cdbb37fad528013872f0fb4008641bd8967015f75149e4a1cf`,
255,274,018B, with Node 24.20.0 and the existing GDAL 3.14 development image.
Standalone converter SHA256:
`aa4aa33d0033d6611dd102baaae98810213f37727d5ff4d00f5274d7081ed151`.
Both active and cancelled proofs used no network during conversion, read-only
source mounts, bounded memory/CPU and the retained original archive. No host
Node/GDAL install, publisher or timer was performed.

## Phone behaviour

Consent is bound to the current account and exact bundled government agreement
hash. The complete text and origin appear before downloads. The camera selects
up to 8 regional shards; root metadata is bounded 256 KiB, each shard 2 MiB, with a
4 MiB app cache. A large camera area asks the skipper to zoom in.

Downloads require a recent successful check and a publisher check no older than
8 days. Hash, byte count, source office, identity, edition, update and issue date
are validated. The original ZIP is persisted and read-back verified before the
normal serialized chart import commits. Originals are account-scoped, limited
to 32 archives / 128 MiB and removable explicitly. Failed native writes reserve
quota honestly and can be retried; they never report an installed chart.

Weekly app checks fetch only the small static root metadata, only with current
consent and normal network. Newer revisions receive a badge and explicit Update
action. A withdrawn catalogue-installed conversion is detached only when its
stored NOAA office, edition, update and content hash still match. The comparison
runs inside the existing same-cell import lock; manual/Pi/alias/protected
replacements remain untouched. Original archives remain for reference with a
visible Withdrawn label. Satellite Mode uses saved metadata and makes no WAN
catalogue/chart request. The service worker bypasses these paths so no secondary
terrain cache can keep a stale mutable index or deleted original.

## Publication review packet

See `scripts/noaa-enc/README.md` for commands, caps, credentials boundary and
rollback. The prepared local pilot generation is
`7d8d345f3e5807b535f1fd9d` in `work/noaa-publication135` outside Git. It lists
all active NOAA coverage but marks only US5CA1LK ready; other cells explicitly
say a verified phone conversion is not yet available. Root index 22,424 B,
largest shard 260,770 B, all shards 2,003,209 B. Empty-remote simulation requires 106
immutable objects / 2,172,964 B plus the mutable root, 2,195,388 B total. The live R2
inventory/ETag has not been queried; the simulation is not an apply authorization.

Initial complete conversion requires 28 bounded 256-cell cycles at most by count;
runtime/output sizes have not been measured globally. No whole global geometry
download or paid/licensed chart source was used. NOAA-only does not imply
worldwide ENC coverage, LINZ ENC or paid charts.

## Validation

67 focused app/consent/source/SW tests pass, as do 8 publisher/archive tests and
13 Pi layer/datum/isolation tests. Pi full TypeScript passes; the shared app
compiler passed after integration. Four actual Chrome/WebKit phone tests at 300
and 375 pixels accepted the terms, fetched only fixed static paths, preserved the
exact real ZIP, imported through the real store, merged the cell, mounted the
normal map renderer and read actual rendered features/framebuffer pixels.
Screenshots were inspected. These are browser/native-boundary proofs, not a
claim of a physical iPhone or live R2 deployment.
