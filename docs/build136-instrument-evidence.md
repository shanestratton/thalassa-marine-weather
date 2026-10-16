# Build 136 instrument evidence checkpoint

136-01/03 pure calculations and additive source evidence; no Pi install, backend deployment or native version change.

## Source-clock contract

Legacy NMEA gauges keep their existing behavior. New `NmeaStoreState.instrumentEvidence` readings carry explicit units, reference, source and original per-sentence/per-leaf time. `measurementTimes.rpm` and the matching `instrumentEvidence.readings.rpm` pair are available to the engine observer. Missing metadata never falls back to GPS, aggregate, row or receipt time. Account/feed retirement clears this evidence.

The unchanged scalar-only relay admits 40 extra keys, each string at most 120 characters, total 4 KiB. The new Signal K extra field `instrument_times_v1` is a JSON string of exactly eight entries: SOG time, true COG time, STW time, TWS time, signed TWA time, qualified RPM time, optional signed leeway degrees, optional leeway time. Missing entries are null. Time entries are positive safe integer milliseconds below 1e14. Leeway is an explicitly reported `navigation.leewayAngle` in radians, converted to signed degrees rounded to six decimal places for this bounded wire format; source is that exact Signal K path. It is never estimated from heel. Existing heading, wind-direction and position clocks remain unchanged for old clients. No schema or relay deployment is needed.

Signal K standard units are m/s, radians and Hz; contradictory explicit unit metadata prevents qualification. A direct true heading or fresh magnetic heading plus fresh east-positive variation can qualify. The derived heading uses the older of both source clocks. A known engine zero requires every reported engine's fresh zero; a fresh running engine wins. The fully populated actual sensor supplement, rolling wind history and AIS extras path is exercised through the production relay parser with exact key equality, <=40 keys, <=120-character string and <4 KiB extra. No truncation is relied upon.

TrackStore nullable migration adds `sog_at_ms`, `cog_true_at_ms`, `stw_at_ms`, `heading_true_deg`, `heading_true_at_ms`, `engine_rpm_at_ms`, `leeway_deg`, `leeway_at_ms`, and `leeway_source`. Old `hdg_deg` remains unqualified. New history can evaluate vectors at `at_ms` only using the separate sensor clocks. This is the 136-04 reader and 136-06 Signal K seam; legacy rows remain readable and never acquire invented clocks.

## Calculations

Measured set/drift subtracts water motion from GPS ground motion in an east/north frame. Source ages must be <=13 seconds and mutually within 6 seconds; heading and COG must be true. STW >=1.5 kn and SOG >=1 kn avoid stationary directional noise; inferred drift over 20 kn is refused. Under 0.05 kn there is no asserted set direction. Explicit usable leeway is applied; absent leeway is clearly uncorrected. This is a local instrument-derived estimate, separate from forecast current.

Performance uses the routing polar resolution and source label for the selected generic vessel. STW supplies VMG and observed performance, never SOG. Polar targets are model estimates and wind outside the table is refused. Powerboats and positive qualified RPM are excluded. Under-sail confirmation is required for observed percentage and local layline guides; unknown propulsion is never inferred to be sail. Local guides are display-only, bounded to a real mark within 5 nm, and current correction requires matching fresh instrument evidence. They make no route, alarm or autopilot change.

Primary references: [NGA Bowditch](https://msi.nga.mil/apology_objects/Bowditch_Vol_1.pdf), chapters 9/36; [Signal K specification](https://signalk.org/specification/latest/), vessel navigation keys and SI units.

## Checkpoint proof

- 86 focused app/core/NMEA tests passed before the six packed-contract cases were added; 15 source-clock/budget/heading contract tests then passed.
- Full app TypeScript and Pi TypeScript passed; 31 non-SQLite Pi source tests passed.
- SQLite migration round-trip regression is added. Local native execution is unavailable because the existing Windows dependencies lack `better_sqlite3.node`; Linux native CI remains required. No security assertion or SQLite test was weakened.
- Instrument panel, preference, history and Obs integration continue in the following checkpoint. Physical sensor calibration and phone behavior remain device verification work.
