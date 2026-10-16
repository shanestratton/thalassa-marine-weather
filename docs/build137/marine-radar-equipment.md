# Vessel radar equipment and feed check

The vessel profile has an optional Marine radar equipment record. No make or model is selected by default. A skipper can choose from 20 named models across four manufacturers, keep a known make with an unknown model, enter bounded plain details for Other/unknown, or clear the record. Model selection is confirmed explicitly with Save equipment. The catalogue is a set of equipment names, without a market-share ranking or driver-support claim.

The existing owned-fleet field-patch path stores `profile.marineRadar` for the active vessel. Clear sends explicit JSON `null`, which survives the offline account queue and removes the server key through the existing JSON merge RPC. There is no migration, new public profile field or change to pairing configuration.

Auto-detect is an explicit one-shot read of the existing enrolled, pinned Pi radar target cache. Its whole six-second deadline includes enrollment reads. Cancellation, synchronous account/vessel retirement (including A → B → A), re-pairing, re-enrollment and original frame clocks fence the result. Only feed status, the paired Pi name and original frame/check times are presented; no raw target positions are retained in the equipment UI.

That cache contains generic TTM/TLL target observations, without scanner identity or a fleet-vessel ID. The result therefore says **model unknown**, labels itself **paired Pi feed**, explicitly says it cannot verify the scanner's fleet-vessel association and leaves saved equipment unchanged. RA talkers and sentence content never identify a manufacturer. No confirmed model candidate is fabricated. Scanner model discovery, radar sweep imagery and scanner controls require a separate integration. This change performs no subnet scan, multicast discovery, transmit/start/range/gain command, Pi installation or live activation.

## Manufacturer references

Official names checked on 17 October 2026; no vendor implementation code was copied:

- Raymarine Quantum, Quantum 2 Doppler, Cyclone and Magnum: [official radar feature comparison](https://docs.raymarine.com/81406/en-US/latest/RadarFeatureComparison-3FE24D8B.html). RD418HD and RD424HD: [official HD radomes](https://www.raymarine.com/en-gb/our-products/marine-radar/hd-radome/hd-radomes).
- Garmin GMR Fantom 18x and 24x: [official announcement](https://www.garmin.com/en-US/newsroom/press-release/marine/garmin-announces-new-gmr-fantom-18x-24x-series-the-most-powerful-solid-state-dome-radars-in-their-class/). GMR 18 HD3, 18 xHD3 and 24 xHD3: [official specifications](https://www8.garmin.com/manuals/webhelp/GUID-0436BE40-091E-49FE-9005-E50CFCABE751/EN-US/GUID-0FC1A76D-F8C8-4CD8-9A4F-80D3666CE625.html).
- Simrad HALO20, HALO20+ and HALO24: [official dome series](https://www.simrad-yachting.com/en-sg/simrad/series/halo-radar/). HALO 2000 and HALO 3000: [official open-array series](https://www.simrad-yachting.com/halo-open-array-radar/).
- Furuno DRS4D-NXT, DRS6A-NXT, DRS12A-NXT and DRS25A-NXT: [official NXT series brochure](https://www.furunousa.com/-/media/sites/furuno/document_library/documents/brochures/brochures/drs-nxt-series_brochure.pdf).

## Source verification

The focused tests exercise catalogue validation, make-known/model-unknown persistence, JSON-null clearing through the real fleet queue, account isolation, actual VesselTab fleet/local save seams, one-shot feed reads, pair/enrollment/cancellation fences and stale-result retirement. The browser fixture uses a synthetic account and RAM-only save; it does not prove a real boat connection or cloud persistence.

Chrome and WebKit at 300/375 px and 130% root text passed all four UI cases, including manual selection/save/clear, unavailable feed check, unchanged saved model, 44 px touch targets and unchanged page bounds. Provider requests were blocked. `work/radar-equipment137-browser-verified-port4283.log` and `work/radar-equipment137-browser-verified-results/` retain results/screenshots. The first passing run exposed a native WebKit select contrast problem during screenshot inspection; the corrected selects and their readable dark controls were then rechecked. The original screenshots and port-collision refusal log remain available.

No physical radar or native hardware acceptance is claimed. The release owner runs whole-app TypeScript, configured production budget, the composed real-page smoke and release checks on the final source.
