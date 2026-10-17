# Reviewed first real-source observation packet

The source/UI checkpoint is `eda5ea980fd011b45be2d0b547253b9f361d5d8e`.
The separate helper and manual workflow in this packet prepare one real-provider
observation. Root must review and explicitly dispatch its exact frozen source SHA.
Preparing/testing this packet performed no image reads. Root subsequently
dispatched its reviewed source once; the actual result is recorded below. No
live app/server feature flag is set by the helper or workflow.

## Exact read plan

`scripts/prove-sharper-satellite-source.mjs` uses the **actual app** fixed registry,
metadata parser, frame validation, image-target builder and bounded MIME/body
transport. It does not call an activated proxy, synthesize provider availability,
or replace the actual parser with a proof-only implementation.

The plan is sequential, without retries, credentials, redirects or persistence in
an app cache. Each product's last at most two **advertised** original frames are
selected. After each image, another actual metadata read must still contain that
frame. If only one frame exists, the helper reads only one. It never requests an
unlisted second frame or assumes a provider's nearest-time response is exact.

| Fixed product                  | Geographic window (west, south, east, north) | Clock restriction                                   |
| ------------------------------ | -------------------------------------------- | --------------------------------------------------- |
| Himawari clean IR Band 13      | 140, −35, 160, −15                           | Original recent GIBS listed instant                 |
| GOES East clean IR Band 13     | −85, 10, −65, 30                             | Original recent GIBS listed instant                 |
| GOES West clean IR Band 13     | −160, 10, −140, 30                           | Original recent GIBS listed instant                 |
| Meteosat FCI IR 10.5 µm        | −10, −10, 10, 10                             | Original advertised UTC clock hour only             |
| VIIRS night polar composite    | 0, 65, 30, 80                                | Original advertised daily date; no instant inferred |
| NOAA upper-water-vapour mosaic | −85, 10, −65, 30                             | Original advertised hourly mosaic instant           |

Every requested PNG is exactly 256 by 256 pixels. There are at most six products,
12 images and 30 total requests (one initial metadata read plus two image/post-read
metadata pairs per product). Each metadata body is limited to 512 KiB and each
image to 2 MiB. The streamed wrapper counts body chunks even for failed reads and
aborts on the 32 MiB aggregate quota; an over-quota chunk is refused and its actual
received count remains in the failure evidence. Thus the quota is an admission
limit, not a claim about exact wire bytes or network/TLS buffering. The evidence
directory itself cannot exceed 32 MiB; 512 KiB is reserved for receipts/failure
details. Each read has 25 seconds and the original overall read deadline is 600
seconds. There is no retry loop, full-disk image, provider bulk download or timer.

## What is recorded and what can pass

The new output directory must not exist. Raw bounded original XML and PNG files,
their hashes, fixed request URLs/status/headers, original advertised frame lists,
source attribution/year, request/read clocks, source SHA and Git-byte input hashes
are retained. Existing locked `tsx` 4.23.7 and `fast-png` 6.4.0 are used; no new
dependency or provider credential is introduced. The workflow records actual Node
and package versions and preserves both success and failure artifacts for seven
days. Every action remains SHA-pinned with its existing version comment.

Before PNG decoding the actual app header/dimension guard runs. The proof then
validates chunk bounds/order, refuses animation/duplicate headers and limits IDAT
inflation to the exact 256² eight-bit scanline size. Compressed ancillary chunks
are excluded before the existing decoder checks critical CRCs. Visible pixels,
partial alpha and at most 512 distinct encoded values are recorded. Unsupported
depth/interlace is held by this narrow diagnostic; it is not labelled a missing
provider product. Uncompressed PNG text is recorded as informational, without
promoting it to an independent acquisition clock.

The process exits zero only if each of the six products has at least one decoded
PNG with visible source pixels **and** retained post-read metadata membership.
Every held product/frame has its actual error; missing data never becomes clear
sky. Two differing hashes prove differing bytes only. No palette value is a
physical-weather measurement. No complete-world availability, acquisition-clock,
nearest-value identity, scan timing, surface fog/visibility or navigation claim
can pass this proof. The explicit `independentAcquisitionClock` remains `unknown`.

## Admission and deployment ordering

The CLI default refuses before network reads or evidence writes. It requires the
exact `--read-reviewed-sources NEW_OUTPUT_DIR` arguments and `SOURCE_SHA` equal to
the actual checkout, and checks all manifest input bytes against that Git commit.
The manual workflow `.github/workflows/sharper-satellite-source-proof.yml` has
`contents: read`, no schedules/secrets/write jobs, and an independent
`allow_source_reads` boolean whose default is false. Root's reviewed isolated
control must pin the exact source and trusted definition before its single run.

Neither this proof nor a passing result enables client/server flags, changes
Vercel CSP/env, deploys a proxy, publishes assets, installs Pi code, modifies R2 or
starts a schedule. Real-source results must be reviewed before any separate
activation decision. The source/UI licence and clock caveats remain in
[sharper-satellite.md](sharper-satellite.md).

## Actual first observation

Run 39002448267 / job 117308040081 used source
`5f9da29ac3fbc86003bb40cbf9de073c22860fba` and isolated control
`38d74a4ddce90969b2ded47c11b130f36abcc111`. It exited one, with four of six
products yielding at least one visible PNG; its historical observation criterion
did not claim usable varying detail. The other products remained held. The
214,711-byte artifact has SHA-256
`4342028ad9917150ee032881c213b3f1a701368ce6550c3ec770e626efcb2560`.
The immutable parent receipt is `outputs/Build14105 satellite first real source
observation.json`; original XML/PNG/headers and failed process exit remain retained.

Uniformly opaque East imagery does not demonstrate usable detail, so current
usable-detail evidence covers three products in those windows only. The new
client pixel hold and exact 334/914-byte regression fixtures are described in the
source document. Nothing from this partial observation enables the feature,
widens source clocks, or proves independent acquisition times. No repeated source
read was made while diagnosing the retained evidence.
