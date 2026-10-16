# 135-03 — observed nearby

Implementation checkpoint, 2026-10-16. Source is prepared for integration review; no build 135 native release or production deployment is claimed.

## Delivered in source

- The inspect popup has an expandable **Observed nearby · buoys & airports** line. Its independent reader can answer when the forecast fails. The viewport-bounded card and history scroll on a small phone.
- Departure Brief has a lazy, unscored **Observed near departure — now** card. It mounts only while the group is open and the selected passage grants both route and checklist access. It is not a future departure forecast and changes no readiness counts.
- Separate NOAA NDBC and AWC METAR rows retain station identity, distance, observation/receipt/retrieval clocks, wind/gust/direction, air temperature, sea-level pressure and airport altimeter/QNH. Missing values stay null; genuine calm stays zero. QNH, sea-level pressure and the boat's ambient barometer are distinct.
- NDBC atmospheric readings use the standard latest-observation text. Wave readers remain separate and retain their existing regressions. Curated NDBC owner credits are reused where known; unknown ownership/exposure stays explicit. A METAR report does not prove a land airport: offshore helidecks also report METAR, so its exposure remains unverified.
- The official daily AWC station catalogue supports worldwide local discovery. Only validated public station IDs enter METAR URLs. Neither the map point nor boat/account identifiers enter provider requests. At most eight nearest catalogue stations are queried; bounded/truncated coverage is labelled.
- Explicit station history supports 12/24/48/72-hour views, with actual retained count/extent, null values, the longest retained interval and marked gaps over 2 hours. Storage is **memory-only for this account/session**, bounded to 32 stations,512 rows per station,2 MiB and 72 hours. A shorter record is not advertised as a complete requested window. Cold-start offline history is not delivered.
- Both native and JavaScript readers enforce fixed NOAA HTTPS endpoints, station-ID/query validation and byte caps. The iOS plugin uses an ephemeral session with cookies, HTTP credential storage and URL caching disabled; redirects are rejected; incoming bytes are bounded before bridging; an absolute 15-second deadline and cancellation are enforced. Ordinary system TLS validation remains intact.
- Native concurrency is two, traffic is bounded to 20 request starts/minute, successful bodies cache for 10 minutes (daily catalogue 24 hours), failures back off 10 minutes, and account changes abort/fence old requests. Closing/changing a consumer aborts its unshared request; shared requests continue only for remaining consumers.
- Satellite Mode/offline uses cached session readings and starts no new observation WAN requests. The excluded web proxy was not created: browser/unsupported-native builds say these sources require the app, rather than pretending no station exists. Both CSPs include the exact AWC origin; CSP does not grant CORS.
- Stormglass no longer calls or merges the legacy atmospheric beacon path. Its new cache identity rejects old station-overridden cache rows while retaining forecast attribution. The direct BOM AWS reader and unused debug wrapper are retired; BOM AWS reuse is not introduced. Legacy wave adapters remain for their independent wave-quality regressions.

## Primary source contracts

Checked 2026-10-16:

- [NOAA AWC API](https://aviationweather.gov/data/api/) documents worldwide METAR/station information, daily gzipped station cache, bounded queries, 204 empty responses and no CORS. Use remains demand-driven and below its documented request ceiling.
- [AWC OpenAPI](https://aviationweather.gov/data/schema/openapi.yaml) specifies Unix-second observation clocks, knots for decoded wind/gust, Celsius air temperature, and hPa for `slp`/`altim`. Receipt time is separate. Only METAR/SPECI records are accepted; an unrequested station identity is discarded.
- [NDBC measurement definitions](https://www.ndbc.noaa.gov/faq/measdes.shtml), [realtime access](https://www.ndbc.noaa.gov/faq/rt_data_access.shtml) and [web data guide](https://www.ndbc.noaa.gov/docs/ndbc_web_data_guide.pdf) describe UTC text columns, true wind-from direction, m/s wind/gust, hPa pressure, Celsius temperature and missing tokens. Station web-page imperial defaults are not used.
- [NWS data-use notice](https://www.weather.gov/disclaimer) distinguishes government material from third-party contributions. Attribution is preserved; NOAA distribution is not treated as blanket permission for every international partner contribution or as NOAA endorsement. No BOM AWS endpoint is used.

## Verification and remaining release proof

- 141 tests pass across observation parsers/history, native-bridge client contracts, discovery/feed/cancellation/account fencing, actual popup/briefing access, Stormglass separation, NDBC/Queensland/Irish wave regressions and existing popup wave display.

- Real read-only checks at six fixed public reference regions succeeded: Brisbane, San Francisco, Solent, Piraeus, Auckland and Caribbean. 118 METAR rows parsed, with all returned identities requested. The catalogue yielded 7730 valid METAR IDs from 9947 public records (358959 compressed/1954868 expanded bytes). NDBC latest yielded 755 usable rows; public station 46042 history yielded 421 rows spanning 71.33 hours. No boat fix, account or paid API was used. Probe source bodies/evidence remain outside Git in `work/public-observations135`.
- A loopback-only browser harness with fictional readings passed 320 px phone, 375 px phone with 30% larger font, and briefing layout. No horizontal overflow; 300-row history remains vertically scrollable. External browser requests were blocked. Evidence remains outside Git in `work/observation135-layout`.
- Focused lint/format/diff checks are clean. The combined app TypeScript no-emit check passes. Production bundle measurement and native Mac/device validation remain release checks. Native streaming/cookie/redirect behavior has not been asserted as a live-device result; hosted compile/device transport proof remains required.
- No backend proxy, provider email, production mutation or build 135 upload occurred for this checkpoint.
