# AROME Outre-Mer source checkpoint

This is the consumer and offline source-planning foundation for 142-06. **It is
not a completed native ingest or a live coverage admission.** The native GRIB
decoder, constant-mask proof, bounded acquisition/storage controller and actual
wx deployment still have to be completed and verified. No provider forecast
packets, server timers, public ingress, secrets or live Edge functions were
changed by this checkpoint. 142-07's own Overpass work is still pending.

The three own model IDs are registered as candidates only. The app never sends
them to Open-Meteo. A model remains absent from the comparison until our fixed
regional Edge operation supplies a current original run on its documented grid,
with a qualified zero-land-fraction cell from the original constant mask.
Unavailable deployment, malformed/oversized data, masked cells and expired runs
remain unavailable. The 49 original UTC lead times are aligned exactly with the
comparison; missing variables and the exhausted local tail remain null.

The API ingress `https://wx-data.thalassawx.app` is a proposed owned deployment
boundary, **not a claim of working DNS or an installed service**. Both the exact
origin and a separate server credential must be configured before its Edge
reader can make an upstream request. The existing tailnet is not a production
client transport. A physical weather-server/public-ingress rollout needs its
own reviewed resource and deployment proof. The two new configuration names
are `THALASSA_WX_REGIONAL_ORIGIN` and `THALASSA_WX_REGIONAL_TOKEN`; secrets stay
on the servers and are never forwarded from a user's bearer.

## Source facts

The official technical description dated 25 June 2024 specifies an hourly
0–48 h horizon, correcting the earlier 42 h description. Captured official
catalogue metadata on 17 October 2026 independently lists all 49 SP1 leads for
the 00Z cycle in each requested domain. No GRIB body was downloaded for that
inspection. The documented Antilles grid is called CARAIB; its current official
forecast object key is **ANTIL**. They are tied explicitly rather than guessed.
The current Polynesia catalogue describes two daily publications; the planner
admits its 00/12 cycles, while NC and Antilles admit 00/06/12/18. There is no
automatic latest-run selection or alternate-host fallback in this planner.

| Domain         | South/north/west/east         | Grid              | 00Z SP1 catalogue bytes |
| -------------- | ----------------------------- | ----------------- | ----------------------: |
| NCALED         | −30, −10, 156, 174            | 721 × 801, 0.025° |             137,377,011 |
| ANTIL / CARAIB | 9.7, 22.9, −75.3, −51.7       | 945 × 529, 0.025° |             271,292,376 |
| POLYN          | −25.25, −12.6, −157.5, −144.5 | 521 × 507, 0.025° |             136,619,068 |

The current advertised packet sizes suggest 1,907,915,684 bytes/day at 4/4/2
cycles, before constants/metadata and changing weather. This is an estimate
from metadata, not actual transferred bytes or a guaranteed future size.
The prepared policy caps are 16 MiB/object, 512 MiB/domain/cohort and **2.5 GB
across the ingest day**, with 49 forecast reads/cohort, 20 s/read, 1200 s/cohort
and a 2 GiB native ceiling. These are proposed limits, not grants of resources
or an activated downloader. Acquisition must charge actual traffic and refuse
before exceeding the admitted envelope; the missing controller must prove it.

The pure planner requires the exact original catalogue, Open Licence 2.0,
complete nonduplicated SP1 membership, fixed official HTTPS object paths,
original source date, bounded declared sizes and an unambiguous original
constant-grid resource. It does not treat planning as native admission. ACCESS-C
remains parked. Coverage hints do not add islands beyond the actual grid.

Primary references:

- [Météo-France technical AROME-OM description](https://donneespubliques.meteofrance.fr/client/document/descriptiontechnique_paquetsaromeom_donneespubliques_v3_20240625_377.pdf)
- [Official NC catalogue](https://www.data.gouv.fr/datasets/paquets-arome-outre-mer-nouvelle-caledonie-resolution-0-025deg)
- [Official Antilles catalogue](https://www.data.gouv.fr/datasets/paquets-arome-outre-mer-antilles-resolution-0-025deg)
- [Official Polynesia catalogue](https://www.data.gouv.fr/datasets/paquets-arome-outre-mer-polynesie-resolution-0-025deg)
- [Météo-France documentation index](https://confluence-meteofrance.atlassian.net/wiki/spaces/OpenDataMeteoFrance/pages/621019138/Mod%2Bles%2Bet%2Bdonn%2Bes%2Bde%2Bpr%2Bvision)

## Checkpoint verification

The focused app run passed 91 cases across the new contract/transport and the
existing coastal capability and model-spread suites. It covers original-clock expiry, exact
point liveness, invalid/land/stale source facts, fixed owned origin, no paid-ID
leakage, body/byte deadlines and exact UTC series alignment. The offline source
planner passed ten test methods with malformed/foreign/partial/duplicate,
rights, clock, host and quota refusals. Its catalogue fixtures are fictional
metadata, explicitly not an actual native decode. Scoped ESLint, Prettier,
Deno formatting and the frozen-lock Deno Edge type check also passed.

Whole-app TypeScript, configured production size, native MF decode, physical
wx acquisition and live consumer admission have not been performed for this
checkpoint. They remain required before calling 142-06 complete.
