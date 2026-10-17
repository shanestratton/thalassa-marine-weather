# 142-04 genuine ensemble bands

Source-only implementation; the new Edge function has not been deployed or
admitted against the existing credential. No purchase, subscription change,
provider bulk read, forecast-model switch or routing adoption is included.

The reachable Glass Model Convergence sheet has an explicit 44 px opener. Its
lazy panel requests either IFS or EC46 only after opening. It uses the existing
server-held `OPEN_METEO_API_KEY`; the browser receives no provider credential.
The new authenticated Edge function consumes at most 12 requests/account/hour,
fixes one location/product, refuses caller URL/time/member parameters, redirects,
responses above 2 MiB and requests past 15 seconds. A provider refusal remains
unavailable, without a free-host, mean or deterministic fallback.

IFS requests the exact `ecmwf_ifs025_ensemble` model (15 days, native time grid).
EC46 requests exact `ecmwf_ec46` individual members (46 days, native 6-hourly
source), rather than seamless SEAS5 or ensemble means. Both use knots and UTC.
Actual last valid time is displayed; the product name does not manufacture
missing coverage. The ordinary response supplies no qualified issue timestamp:
`issuedAt` remains null and the UI says so. SHA-256 binds the received original
JSON; receipt time is labelled receipt, never issue time. Opening a panel for
30 minutes expires its receipt without silently refreshing it.

The reducer accepts unique IDs 0–50, including an unsuffixed control, and refuses
control aliases, malformed member names, wrong units, nonfinite/out-of-range
numbers, misaligned time arrays and a returned grid point over 100 km away.
Missing values are excluded separately per variable/time. At least 41 of 51
members are required for a band; every unavailable count is visible. Percentiles
use linear interpolation at `(n−1)p` (type 7). Exceedance means `>=25 kt`, with
the actual finite-member denominator. The shaded p10–p90 area and median break
at missing hours and use elapsed time, not equal spacing of irregular steps.
Frequencies are explicitly not calibrated probabilities or guaranteed ranges.
No fake members are generated from deterministic model comparisons.

Primary sources checked 17 October 2026:

- [Open-Meteo ensemble API](https://open-meteo.com/en/docs/ensemble-api)
- [Open-Meteo seasonal API](https://open-meteo.com/en/docs/seasonal-forecast-api)
- [Official ensemble OpenAPI](https://github.com/open-meteo/open-meteo/blob/main/openapi/ensemble.yml)
- [Official seasonal OpenAPI](https://github.com/open-meteo/open-meteo/blob/main/openapi/seasonal.yml)
- [Professional-plan product access](https://open-meteo.com/en/pricing)

The user has already stated that Professional is active. The existence of
`OPEN_METEO_KEY` in wx `/etc/thalassa/capture.env` was checked without exporting
values; that is presence evidence, not proof that this Edge credential can access
both products. An exact bounded capability/deployment/readback review remains.

Focused proof: 109 cases in five suites, including the original model matrix and
commercial-secret boundary, pass. These are fictional payload/UI fixtures,
not live provider acceptance or physical-phone proof. Browser phone geometry,
Deno checking and final configured byte measurement remain before release.
The existing JavaScript/asset ceilings are unchanged.
