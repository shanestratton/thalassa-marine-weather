# Build 138: this boat's sail inventory

Vessel → Sails opens a lazy editor for the selected boat's sail names, kinds,
true-wind reef points and crossover plans. The profile is optional and uses the
existing private account/vessel settings path. It starts empty. No yacht, rig,
sailmaker threshold or polar is supplied as a default. Nothing is added to the
Instrument Panel.

Each plan has a true-wind range, true-wind-angle range and an explicit selection
of sails and minimum reefs. User-entered reef points may add reefs sooner. The
recommendation uses the stronger of covered true wind and a known gust. Missing
gust remains missing. Stronger wind takes effect immediately; a user-set wind
drop band only delays increasing sail. Changing account, boat, inventory,
forecast source or the direction of the time sequence clears that held advice.

The passage HUD shows this advice only while looking ahead with covered named
wind. The expanded passage leg list samples the actual start time and distance
of each leg. It reuses a fresh route forecast, or offers an explicit bounded
load through the existing named-model route forecast service. Satellite Mode
uses the cache only. Missing spatial/time corners, an expired forecast, no
inventory or a motorboat show unavailable; the existing display sampler keeps
its original behavior. A candidate leg list must match its exact route geometry
before its timing is used. This is planning advice, not an instruction to change
sail or a claim that modeled conditions match those aboard.

The editor holds unsaved changes locally. Boat/account changes close it and a
late Save cannot write the previous boat's draft into a different profile.
Validation rejects a malformed whole inventory rather than silently dropping
selected sails. Bounds are 24 sails, 32 crossover plans, six reef points per
sail and 32 KiB of normalized profile data.

Focused tests cover different inventories and motorboats, threshold hysteresis,
stronger-wind changes, unknown forecasts, zero values, identity changes,
complete route sampling, profile saving and stale async loads. The browser
fixture uses fictional vessel data, page-only storage and a `connect-src 'none'`
policy. It checks the actual Vessel editor at 300/375 px with 130% text in
Chromium and WebKit, including Save and account/boat dismissal. Provider
activation, a physical-device check and the final full-138 release gates remain
separate work.
