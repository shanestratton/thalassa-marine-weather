# Build 133-03: coastal wind

This package implements the confirmed 14 October roadmap's 133-03 client and proxy vocabulary. It does not deploy the proxy or a weather publisher.

The Glass ECMWF choice becomes `ecmwf_ifs` (9 km) only after the paid proxy returns finite 10 m wind for at least half the requested 24 hours. Existing `ecmwf_ifs025` pins migrate then; Auto and other pins do not. A delayed migration checks the originating auth identity and the current pin before writing. Refused probes back off for an hour; positive and null verdicts last a day. Records, failures, and concurrent probes are bounded to 64; regional verdicts are local to a 0.1-degree point key. No publisher row is capability evidence.

Glass atmospheric requests and the comparison request `cell_selection=sea`. Published rows are accepted only with the explicit `thalassa_provenance` contract below; existing coarse rows and the unproven Pi combined cache fall through to the commercial proxy. An unavailable 9 km request retries the real `ecmwf_ifs025` domain and retains its coarse model tag. Comparison rollback similarly retries the established catalogue once. Null and non-finite values remain gaps.

The comparison adds at most one regional member, within the existing eight-model cap. Conservative rectangles are selection hints rather than an exact domain guarantee; finite proxy data is still required. The finest grid wins overlaps, with catalogue order breaking ties (Paris uses AROME HD ahead of ICON-D2). Regional series stop at their documented maximum horizon and may end sooner in the actual run. No native domain is extended with a global tail. Outside supported regional data the sheet says “Global models only”. Its expandable table shows each model's raw metrics at the named time, with missing fields left blank.

UKV is labelled UK Met Office, CC BY-SA 4.0 and display only. It is available only in the comparison's raw lines/table. Its values and membership are excluded from wind/day agreement, every metric's derived spread/confidence, and the circular mean used for chart centring. It is not added to the Glass picker, routing, alerts, blends, or briefing inputs.

## Proxy deploy required

Deploy the existing `proxy-openmeteo` function with this package's `validation.ts`: `ecmwf_ifs`, the twelve regional IDs, the three tertiary swell fields (height, direction, period), `lifted_index` and `convective_inhibition`. `secondary_swell_wave_peak_period` is refused. The three fixed customer hosts, eight-model limit, 32-variable limit, and existing Sounding pressure-level vocabulary are unchanged. No public/free endpoint or new subscription is introduced.

After deployment, verify finite single-model sea-cell wind through the commercial proxy at a point inside each advertised domain. Check a refusal/rollback, an all-null reply, a short regional run, Airlie's sea-cell selection, and an existing ECMWF pin on device. The UI gate will stay closed for a model that the deployed proxy does not serve.

## Weather server dependency

The inspected companion `shanestratton/thalassa-weather-server` repository at `f8b7f47f4d3fe5bfafc458d198d59380039b4bda` contains operational documentation/scripts, not the deployed HTTP router or publisher source. No disconnected alias module is invented here. In that deployed router, the lab-only `ecmwf_ifs` request must map to the installed `ecmwf_ifs025` dataset as requested by the roadmap. Its response/published record must identify the actual model as `ecmwf_ifs025` and the coarse resolution; that alias cannot establish commercial 9 km capability or be published under a 9 km identity. Phones continue to use the paid proxy when provenance cannot prove the requested data.

If the publisher is later changed to fulfil a coastal read, it must attach this object to the response-shaped payload, populated from the actual upstream request and model (not inferred from the table row key):

```json
{
    "thalassa_provenance": {
        "version": 1,
        "model": "ecmwf_ifs",
        "cell_selection": "sea",
        "latitude": -20.27,
        "longitude": 148.72
    }
}
```

The client requires the exact requested model and query coordinates within 0.0001 degrees. A 0.25-degree cell centre is not the original query point. Aliased ifs025 rows continue to identify ifs025 and cannot satisfy an `ecmwf_ifs` read.

## Sources and validation

Model IDs were checked in Open-Meteo's [forecast controller](https://github.com/open-meteo/open-meteo/blob/main/Sources/App/Controllers/ForecastapiController.swift). Resolution/horizon tables were checked on the official [Météo-France](https://open-meteo.com/en/docs/meteofrance-api), [DWD](https://open-meteo.com/en/docs/dwd-api), [UKMO](https://open-meteo.com/en/docs/ukmo-api), [KNMI](https://open-meteo.com/en/docs/knmi-api), [DMI](https://open-meteo.com/en/docs/dmi-api), [MET Norway](https://open-meteo.com/en/docs/metno-api), [GFS/HRRR](https://open-meteo.com/en/docs/gfs-api), [GEM/HRDPS](https://open-meteo.com/en/docs/gem-api) and [JMA](https://open-meteo.com/en/docs/jma-api) documentation on 15 October 2026 UTC. HRRR's maximum 48 hours applies only to its four extended runs; actual missing hours stay missing. The UKMO page specifies CC BY-SA 4.0.

Local checks: pinned Prettier 3.8.1 parsing/formatting; Deno 2.9.4 ran the proxy validation suite (11 passed) with a local Node assert adapter because JSR access was unavailable; a separate Deno harness type-checked and exercised the real registry, capability, pin migration, provenance and spread/day-agreement modules with a deterministic proxy stub (6 passed). The committed Vitest tests cover capability changes, failure backoff, Paris priority, provenance, UKV exclusion for every atmospheric metric and passive swipe request counts. Full repository TypeScript/lint/Vitest, production bundle budgets and on-device layout remain integration checks. No live proxy, publisher, Pi, Supabase or store deployment was performed.
