# CMEMS Ocean-Waves Pipeline

This producer downloads the Copernicus Marine global wave analysis and
forecast, validates its scientific metadata, and builds a schema-v2 immutable
bundle. It cannot publish releases. A separate isolated publish job revalidates
the sealed bundle before exposing its manifest.

## Timing and freshness contract

- Source dataset: `cmems_mod_glo_wav_anfc_0.083deg_PT3H-i`
- Variables: `VHM0` in metres and `VMDR` in degrees with their exact expected
  CF standard names
- Window: 17 snapshots at three-hour cadence (`T+0` through `T+48`)
- Schedule: `07:00` and `19:00` UTC, exactly 12 hours apart
- Maximum source age: 15 hours, comprising the 12-hour publish interval plus
  one exact three-hour native-cadence margin

The publisher and client both fail closed after that 15-hour boundary. The
margin prevents a routine outage while the next twice-daily run is processing;
it does not extend forecast coverage or permit a stale dataset whose 48-hour
window no longer covers the current time.

## Encoding and trust separation

The producer performs a height-weighted circular mean for direction and retains
the arithmetic mean `VHM0` magnitude. Near-cancelling directions use the
deterministic direction of the tallest native system, with the lowest normalised
bearing breaking exact ties. It validates finite masks, global coverage,
dimensions, cadence, CF axes, physical units, payload length, and mask invariance
before creating `manifest.draft.json`.

The generation job has Copernicus credentials and read-only repository access.
The publish job has repository write permission but no source credentials or
producer dependencies. It binds the sealed draft's commit and run ID to the
workflow context and accepts an earlier producer attempt only when a failed
publisher is rerun in that same workflow run. Immutable assets are written to
the deterministic UTC ISO-week release shard. After remote size and SHA-256
verification, the publisher updates only the inactive dual v2 manifest slot; a
first publication seeds both slots. Run-stable artifacts are retained for one
day: rerun only the failed publisher inside that window, or rerun all jobs after
it.

## Attribution

The visible layer must retain Copernicus Marine Service attribution and product
DOI `10.48670/moi-00017`.
