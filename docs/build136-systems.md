# Build 136: read-only Systems page

The Vessel menu has a lazy Systems entry. Six compact panels show the selected reported battery, tank, solar, AC/charger, engine and autopilot-state readings. Sender selectors change the displayed record only. There is no relay, inverter, charging, autopilot or other equipment command in this feature.

## Data and identity

The Pi reads bounded existing Signal K self-document leaves. Every admitted numeric/state leaf needs its own timestamp and selected `$source`; neither a parent timestamp, GPS clock, publish/receipt clock nor a sibling sender qualifies it. Unknown units, invalid ranges, missing source identities, old/future readings and oversized instances remain absent. Metrics from different selected sources on the same named instance are kept separate. Instance/source identifiers are never guessed to mean a physical house bank, a particular tank sender or a connected shore cable.

The fixed units are battery V/A/SOC percent, tank-level percent, solar panel W/V/A, charger V/A/Celsius, AC phase W/V/A and the reported autopilot state. Percent values come from actual ratio leaves; temperature comes from Kelvin. AC power is labelled AC power. Battery positive current means discharge under Signal K's current convention. Solar power is the measured panelPower leaf, not inferred V times A. Engine readings reuse the identified RPM and original-clock engine contract; another engine's meters cannot accompany it.

Primary schema references: [Signal K electrical schema](https://github.com/SignalK/specification/blob/master/schemas/groups/electrical.json), [steering schema](https://github.com/SignalK/specification/blob/master/schemas/groups/steering.json), and [vessel keys](https://signalk.org/specification/1.7.0/doc/vesselsBranch.html). The reviewed current electrical schema SHA256 was `a07479ea899f72e1ea783264b4181ec333d22a7644b383ae744603fc75f9dad2`.

## Wire budget and age

At most eight sys_0_v1 through sys_7_v1 strings carry `[1,kind,instance,source,baseEpochMs,value,offset,...]`. Every string stays within 120 characters and retains each original leaf clock through its offset. Discovery is capped at 64 instances per collection, with at most two records per group and bounded group fairness. No arbitrary path subscription is introduced.

Optional Systems packs stay separate from snapshot.extra until buildTelemetryBody appends them after all existing leading, instrument, supplement/history and trailing capability keys. Admission stops within the existing 40-key and 4-KiB limits. A full critical path is preserved unchanged; missing optional Systems data never means zero, no hardware or a certified connection. The existing relay schema, security policy and limits are unchanged.

The independent Systems leaf window is 180 seconds; values older than 15 seconds show their age without a fresh colour, and expired values become unavailable. Repeated polls do not renew sensor clocks. A stale GPS report can set aside navigation while preserving independently qualified Systems leaves; the transport report time never replaces those leaf times. A tank-only document survives without GPS, RPM, voltage or other navigation scalars.

The page retains values in RAM only. Account generation, pairing and active-vessel changes retire its displayed data, including a change between rendering and effect subscription. NmeaStore clears retained Systems records alongside its existing evidence lifecycle. No weather, chart, map or external provider request is made by the page.

## Verification and installation boundary

Focused tests cover real collector/supplement/relay/wire round-trips, existing telemetry regressions, unchanged full critical budgets, unit conversion, distinct senders, missing/zero/stale readings, stale GPS, tank-only input, account/pair/vessel races, identified engines and lazy focus return. Chrome and WebKit cover 300 and 375 px at 30% enlarged text, every card inside the viewport, actual screenshots, sender selection, unknown hardware and no remote requests.

The source requires the later reviewed Pi update to publish these optional fields. Tests use generated documents; no claim is made that any particular boat has the sensors installed or reporting. This checkpoint does not install or deploy the Pi code, change the relay, or send equipment commands.
