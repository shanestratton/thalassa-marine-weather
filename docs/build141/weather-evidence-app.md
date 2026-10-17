# Issued station evidence and measured seas

The model picker contains a lazy, explicitly opened skill panel inside its
existing scroll area. Coordinates select the closest current published station
within 50 nautical miles locally; no position or account data is sent to the
publisher. No nearby station means partial coverage. A warming station is named
without MAE, a winner or automatic model selection.

Scores remain separate by wind speed, wave height and original forecast lead.
The client repeats the server's two-week, effective-N ≥ 30, ten-day span and
comparable-model gates. Exact source IDs remain distinct: own-server IFS 0.25°
skill does not score IFS 9 km, a blend, another provider or motion seas. NOAA
observations retain their preliminary automated realtime screening label.

The reader is import-inert. Explicit caller-owned sessions fetch only fixed
public paths, omit credentials, refuse redirects and verify original index/detail
lengths and SHA-256. Pointer, index, detail and cumulative session limits are
1,024 B, 256 KiB, 128 KiB and 2 MiB. At most four actual unsettled native fetches
can exist across remounts; an abort-ignoring fetch retains its slot until it
settles. No global data or durable cache exists. Each session retains at most two
details for at most 15 minutes and respects original pointer and station expiry.
Closing retires its session. Expiry never initiates a background refresh.

Buoy cohort availability accepts at most 90 minutes after construction, matching
reviewed weather source `13e0ab73`. Each station independently retains its
original observation-plus-three-hour/rights ceiling. Old one-hour pointers keep
their original clocks. A current cohort cannot revive an expired station.

Measured seas is a separate, default-OFF entry in the existing Sea submenu. Its
lazy vector owner activates only in foreground Obs, preserves chart ordering,
and removes only geometry it owns. It emits at most 64 viewport points with at
least 44 px separation; zooming can reveal thinned stations. A 44 px query opens
a bounded card with original 72-hour samples and only forecasts captured before
their valid hour. Missing values and gaps remain empty; zero stays zero. This
display does not claim forecast accuracy, water clearance or safe navigation.
There is no camera movement, background refresh, route/watch adoption, ownship
upload or model switch.

Card interaction suppresses competing chart popups and Clear view. Foreground,
source, expiry and cancellation checks fence stale details and geometry. A
failed layer removal retains an explicit caution. Credits use the existing
single rollup, including source, preliminary/provisional QC and partial coverage;
no extra map strip is added. The card and credits sheet have persistent 44 px
Close footers. Source links scroll within the same capped sheet.

The original fixtures are actual collection-only candidates from wx, separate
from independent public-copy deployment proof. They contain 29 public
institutional buoy stations and 20 warming skill stations. They contain no yacht
positions, secrets, fabricated scored history or live account.

Focused proof: 137 cases in 16 suites passed, including contract, session,
ownership/expiry, actual foreground retirement, picker/status and menu reset.
The actual native-select appearance was inspected in WebKit and corrected with
explicit dark control colors. Initial phone failures and the native-color
receipts remain in `work/validation141-evidence-*` and their output directories.
The separate footer commit proves all six real Mapbox 300/375/430 px at 130%
cases, including bottom-scrolled Close, unchanged map frame and 667 px document
extent. The earlier full 54-case run also preserves all 12 original 137 credit
assertions unchanged. The final 42-case Chrome/WebKit run passes at 300/375/430 px,
normal and 130% text, after both persistent footers were installed:
`work/validation141-evidence-centered-final-phones.log`, screenshots under
`work/evidence141-centered-final-browser`. Native dark selects, source links and
the bottom-scrolled card Close were visually inspected. Every test keeps exact
clipped 44 px targets, a real hit test and 667 px document extent. Chromium's
nearest-scroll API left a fractional edge clipped despite available scroll room;
the proof centers controls in the real scroll container before those unchanged
assertions. An intermediate rerun omitted the existing WebKit runtime environment
path and failed at browser launch; that receipt is preserved too.

Whole-app TypeScript, configured JavaScript/total budgets and physical phone
acceptance remain separate release gates. The private own-boat instrument
scorecard is a separate pending packet; institutional buoy skill does not supply
its ground truth.

After final formatting, the 11 directly relevant suites pass all 119 cases
(`work/validation141-evidence-source-final-focused.log`, SHA-256
`6852dfb8868d586ec68f9373f5e374f4f1f35856fdc9ff16fe760d8a36404dac`).
The 42-case final browser log SHA-256 is
`7119a04c977489ea9ca933ac37b95765fe53bee74c16b56f33b29e77eb11a04f`.
Scoped ESLint has zero errors; MapHub retains its six inherited warnings.
