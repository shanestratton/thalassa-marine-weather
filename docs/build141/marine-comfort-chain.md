# Marine and comfort chain — source checkpoint

The versioned transport is prepared, tested and not yet adopted by the Glass. No get-marine deployment or Pi installation has occurred in this packet. The active StormGlass chain is still present until equivalence, final enrichment and alert checks pass.

Schema 2 makes two parallel bounded upstream requests: `meteofrance_wave` for total/wind-sea/swell/secondary-swell, and independent `best_match` for temperature/current. Each keeps its original valid clocks, units and actual answering grid cell. Receipt time is explicitly not a model issue time. Sources are independently snap-checked; missing, distant, land-mask, stale-current or wrong-unit values stay unknown. Report heights convert metres to feet once; current converts km/h to m/s once.

The client uses the existing pinned Pi transport, then fixed Supabase endpoint, each with a four-second waiter bound including delayed header/body work. Legacy Pi replies cannot pass schema 2. Auth/vessel/pair revisions fence late promises, including A-B-A; no retired promise can refill RAM. Public forecast RAM is limited to32 points and8 total active reads, including retired reads. Nothing persists positions or provider keys. A five-minute local cache retains original server receipt and source clocks.

The Pi schema-2 namespace uses four-decimal coordinates, five-minute TTL and zero stale-while-revalidate window. It also explicitly refuses generic cache fallback marked stale: generic weather caching can otherwise return expired data after an upstream failure. The legacy route remains available for installed older clients.

Canonical source is `supabase/functions/_shared/marine-v2.ts`; `pi-cache/scripts/sync-marine-v2.mjs --check` verifies its generated Pi copy. The new upstream helper caps each body at750,000 bytes and aborts headers/body after3.5seconds. The client caps each received response at1,600,000 bytes. No existing cap increases.

Current local proof:121 cases across6 app suites, plus6 real Express Pi route cases. These include actual transport/body deadline controls, separate motion/wave cells, missing/wrong-unit samples, original clocks, legacy cache refusal, bounded joins/cache and identity/vessel/pair retirement. The first attempted app Vitest import of Pi Express failed because Express is a Pi-only dependency; the real route tests now run in the Pi's own Node/tsx environment. No whole TypeScript or configured production build is claimed.

Remaining work: actual Glass/offshore source adoption and stored `sg` migration; final-report alert recomputation; move buoy merge out of StormGlass; truthful enclosed-water unknowns/reasons and credits/Terms; fixed-footprint sea partitions/comfort on Glass/HUD and departure inputs; genuine private per-vessel report collection/calibration with account deletion and isolated database proof. Old provider shutdown/cancellation remains a separately coordinated operational step after testers update.

Primary provider reference: <https://open-meteo.com/en/docs/marine-weather-api>. In particular, requesting the named wave model alone cannot provide the independent water-temperature/current product.
