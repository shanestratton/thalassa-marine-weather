# Local voyage names and ownship label — 25 September 2026

- OBS status/speed badge moved down to reserve a separate row for the AIS
  vessel name. The marker's GPS origin, heading and zoom anchoring are unchanged.
- Log cards, archived cards and auto-named planner routes prefer nearby named
  marine places to a weather district. User-authored saved titles are not rewritten.
- The bundled, attributed Queensland gazetteer includes 1,196 current islands,
  bays, harbours and anchorages. Clear local matches resolve offline. Coverage
  elsewhere still uses the existing global geocoder; this is not worldwide
  marine gazetteer coverage.
- Gazetteer points are not boundaries. Islands must be within 2 km, smaller
  marine features within 800 m. Competing different names within a 150 m
  distance margin are treated as ambiguous, not guessed.
- Ambiguous positions use a paced, deduplicated, cached Nominatim lookup with
  native and JavaScript deadlines. Its nearby village/island/harbour wins over
  district names; roads, businesses and protected-area names are not endpoints.
- The old final Log fallback's five widening requests are replaced with one
  paced detailed request. Failures retain the broad geocoder/coordinate fallback.
- Reverse naming changes display labels only; no saved GPS fixes, track shape,
  departure/arrival times, route directions or navigation safety checks change.

## Field reproduction

Actual 25 September fixes: Daydream (-20.2543216666667, 148.815016666667),
Hamilton (-20.3475033333333, 148.949890666667).

Daydream has a clear nearby gazetteer match (160 m). Hamilton's representative
island point competes with Cowrie Island, so it deliberately uses the detailed
lookup. Live Nominatim verification returned a nearby result at
(-20.3471589, 148.9499519), `village=Hamilton Island`,
`city_district=Whitsundays`; the village is selected, not Acacia Drive or the
district. These positions are reproduction evidence, not new navigation points.

## Verification

- 29 focused endpoint/hook/route-name/route-picker tests pass.
- 27 ownship marker/status tests and Chromium/WebKit layout checks pass,
  including zoom/bearing/pitch anchoring and stopped/underway labels.
- Gazetteer refresh verifies source licence, full pagination, record count,
  source IDs and transformed coordinates before writing; no scheduled job added.

Sources: [Queensland Gazetteer](https://www.data.qld.gov.au/dataset/place-names-gazetteer-queensland),
[Nominatim reverse API](https://nominatim.org/release-docs/latest/api/Reverse/),
[usage policy](https://operations.osmfoundation.org/policies/nominatim/).
