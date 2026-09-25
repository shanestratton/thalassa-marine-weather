# Ownship bow-heading telemetry

The OBS vessel arrow needs bow heading, not stationary GPS course-over-ground.
The Pi now adds two optional fields to the existing telemetry `extra` JSON:

- `heading_true_deg`: true-north bow bearing, finite and normalized to `[0, 360)`; north is valid zero.
- `heading_true_at_ms`: the original heading sensor envelope time, in epoch milliseconds.

Both are omitted unless the heading sensor has its own valid timestamp less than 15 seconds old.
Future timestamps, missing timestamps, inherited parent/GPS clocks, malformed numbers and invalid angular ranges
are rejected. Fetching Signal K again does not refresh the sensor time.

Fresh `navigation.headingTrue` takes precedence. Otherwise a fresh `navigation.headingMagnetic` is converted only
with a separately fresh `navigation.magneticVariation`. Signal K defines these angles in radians and easterly
variation as positive, so `true = magnetic + variation`. See the
[official Signal K vessel keys](https://signalk.org/specification/1.5.0/doc/vesselsBranch.html).
The timestamp remains the heading sensor's original time. Each publication rechecks both input ages.

The historical `headingDeg` / `heading_deg` field is unchanged for compatibility and must not be treated as proof
of true heading by an orientation display.

## Transport and rollout

`buildTelemetryBody` carries `extra` unchanged for both LAN telemetry and the cloud publisher. The deployed
telemetry-relay parser accepts these bounded-size named numeric extra fields, and `vessel_telemetry.extra` already
stores JSON. No database migration or Edge Function deployment is required for this metadata.

The Pi service must be updated before older installations can emit the new fields. Building/syncing the iPhone app
alone cannot supply missing true-heading metadata. Until then the frontend must treat bow orientation as unknown
when there is no other fresh reference-qualified heading source.

This change does not deploy to or restart a running Pi. For an operator-approved maintenance window, the existing
`pi-cache/redeploy.sh` is the repository's rollout entry point; it copies the current source to
`/opt/thalassa-pi-cache`, builds, and restarts `thalassa-cache`. Review the complete source being deployed and the
script's restart impact first. Live Anchor/Shore Watch and recording must be accounted for before that restart.

Local checks (no boat connection):

```sh
cd pi-cache
npx tsx --test src/headingTelemetry.test.mts src/trackSignalk.test.mts src/telemetryPublisher.test.mts src/lanTelemetry.test.mts
npx tsc --noEmit
```
