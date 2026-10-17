# Build 135-01: imported GRIB attachments

The local import path supports actual 10 m U/V wind and mean sea level pressure
from bounded GRIB1 and GRIB2 attachments. It does not infer a forecast model from
the producer identifier, replace missing cells with calm wind, or fetch a provider
when a local file is invalid or expired.

## Data and lifecycle

- iOS declares an imported GRIB UTI and a Viewer document type. The existing
  `boxLinks` app URL/launch URL handler owns both cold and warm handoff; its short
  duplicate window is scoped to the current account. No parallel app URL listener.
- `GribDocumentPlugin` coordinates a security scoped local read and streams a
  bounded private copy into Capacitor `Directory.Data`. Documents sharing and
  opening app documents in place stay disabled. The native cap is eight saved
  files and 64 MiB total; a single attachment is at most 32 MiB.
- Validated metadata contains an owner namespace, internal random path, byte size,
  SHA-256 and active selection. External URLs and filenames are not persisted.
  Restore verifies the raw checksum and decodes again. A failed replacement keeps
  the previous good selection; failed and late copied candidates are removed.
- Account changes terminate decoders and synchronously remove the previous local
  field. Remove-file and Use-online actions are explicit. A new user import fits
  its bounds once; restore and forecast time changes do not move the camera.

## Decoder boundary

Each import uses one disposable Worker, a ready/transfer handshake, a ten second
deadline and cancellation/current-account checks. There is no page-thread decode
fallback. Caps: 512 messages, 128 forecast frames, one million wind grid cells and
64 MiB reserved decoded output. Imported pressure is capped at 65,536 cells for
the existing contour renderer.

Supported geometry is full regular latitude/longitude with explicit increments,
earth relative vectors and the eight ordinary i/j scan orders. Supported packing
is GRIB1 simple packing (IBM reference float) or GRIB2 template 5.0 simple packing,
up to 32 bits. Explicit bitmaps and constant fields are supported. Unsupported
projections, reduced/staggered/alternating grids, ensemble/interval products,
complex/JPEG/PNG packing and reused/predefined bitmaps fail explicitly.

U and V pair by actual forecast time within one source, run and grid. Duplicate
fields, mixed runs, partial vectors, malformed sections, implausible values and
all unknown fields are rejected. Pressure converts Pa to hPa. Actual run and
nonuniform forecast times survive decoding, storage restore and display.

Imported wind uses the existing WebGL custom layer, loaded only for an import.
The usual Leaflet velocity renderer coerces unknown vectors to zero and is
therefore excluded from this path. Bitmap holes remain transparent in both wind
and pressure. Imported coverage never borrows boat instruments or provider data.
The strict `sampleWindGrid`/`sampleImportedGrib` helpers return unknown outside the
actual time window, spatial bounds or known interpolation cells.

## Evidence and remaining acceptance

Generated fictional binary fixtures cover both editions, scan orders, signed
scales, bitmaps, time/source pairing, malformed inputs, allocation limits,
cancellation, private selection/restore and account races. Local Chrome and WebKit
exercise the actual Worker transfer and cancellation plus real WebGL unknown-cell
transparency and forecast clock changes. React lifecycle tests verify that imports
select the custom layer and remove it without starting Leaflet or boat lookup.

No licensed chart data, real boat data, upstream downloads or real mail attachment
is included in those tests.

**Still pending:** a genuine Saildocs/Winlink reply, signed Mac native compilation,
and physical iPhone cold/warm Mail/Files acceptance (including security scoped file
providers and cancellation). Source/XML registration tests do not prove a native
build or device handoff. This is an implementation checkpoint, not full 135 or
TestFlight acceptance.

The roadmap's +12 KiB estimate is not a verified size result. Root must measure the
complete production bundle against the unchanged release budget before release.

Primary format references: [NCEP GRIB1 ON388](https://www.nco.ncep.noaa.gov/pmb/docs/on388/),
[GRIB2 grid template 3.0](https://www.nco.ncep.noaa.gov/pmb/docs/grib2/grib2_doc/grib2_temp3-0.shtml),
[product template 4.0](https://www.nco.ncep.noaa.gov/pmb/docs/grib2/grib2_doc/grib2_temp4-0.shtml),
[packing template 5.0](https://www.nco.ncep.noaa.gov/pmb/docs/grib2/grib2_doc/grib2_temp5-0.shtml).
