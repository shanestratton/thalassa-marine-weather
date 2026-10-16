# 137-01: preset rule model review checkpoint

This checkpoint provides evaluation primitives, not an enabled alarm service.
Every default rule is disabled with no sensor selected. No app or Pi startup
entry imports the evaluator, and no audio, notification, relay, settings or
server endpoint is registered here. Existing watches retain their leases.

## Public API

- `utils/wakeRule.ts`: `defaultWakeRules()`, `evaluateWakeRule(rule, state,
reading, now)`, `initialWakeState()`, validation and fixed priority helpers.
- `services/alarms/phoneWakeRule.ts`: `evaluatePhoneWakeRule(rule, state,
context)`, while the phone is alive.
- `pi-cache/src/wakeRuleAdapter.ts`: the same evaluation API over the generated
  pure graph. Adding the adapter does not install a Pi keeper.
- `utils/wakeRuleInputs.ts`: `wakeReadingFromSignalK` for a qualified local
  boat document; its result retains the original sensor clock. No configured
  path is accepted. The context explicitly identifies the current feed and
  whether the source is an approved local boat source. Generic NmeaStore gauge
  receipt clocks, cloud report clocks and the newly added direct-device lane
  do not become qualified automatically.

The eight fixed presets cover below-keel depth, true wind over water, SOG,
measured station-pressure fall per three hours, engine coolant temperature,
engine oil pressure, engine RPM and battery voltage. Engine and battery
thresholds start unknown: the software does not invent equipment redlines or
nominal bank voltage. Comparisons and units belong to the preset. Each selected
feed, physical `$source`, reference, engine/bank instance and threshold must be
explicit before a rule can qualify.

Signal K inputs use the specification's SI units, original leaf timestamps and
the selected `$source`. Missing unit metadata uses the specified canonical SI
unit; conflicting metadata is rejected. A parent's timestamp cannot qualify a
leaf. Engine presets require exactly one identified engine in the document;
low oil also requires fresh positive RPM on that engine from the same selected
source, within six seconds of
the oil reading. Selecting the first available engine/battery is forbidden.
The fixed paths and conversion definitions follow the primary
[Signal K vessel reference](https://signalk.org/specification/1.5.0/doc/vesselsBranch.html).

## State and timing contract

Only fresh, strictly increasing measurement timestamps can advance minimum
duration or clear duration. Stale, missing, wrong-source, nonfinite, future or
out-of-order evidence neither fires nor clears an alarm; it breaks pending
confirmation/clear runs and retains an already active alarm. A sample gap
longer than that preset's maximum age also breaks the run. Repeated HTTP polls
of one leaf cannot accumulate confirmation time. A backwards evaluation clock
is unknown rather than an all-clear.

An active alarm clears only beyond its threshold plus/minus hysteresis for
fresh consecutive clear samples. `transition` distinguishes measurement
`fire`/`clear` from explicit user `disabled`/`reconfigured` actions. A config
change resets that rule's state; malformed configuration holds an existing
alarm as unconfigured instead of asserting safe sensor values. The eventual
controller must keep state per account/rule and dispose it on account/pairing
change. A caller must not replay another account's in-memory state.

Quiet hours use explicit start/end local minutes and a fixed boat UTC offset,
including midnight crossings. The editor must label that offset and update it
on a timezone/DST change. Quiet hours suppress delivery only; the active state
remains. Consumers must follow `audible`, not just a `fire` edge, so ending
quiet hours can restore delivery without inventing another sensor episode.
No quiet-hours rule suppresses an existing anchor/collision/distress watch.

Depth uses an original below-keel reading as-is, including a negative value.
A current same-source transducer-to-keel offset may be folded into raw depth.
Otherwise the full draft is subtracted conservatively, matching
`keelOffsetFor`; a missing draft remains unknown. `depthBasis` preserves
`below-keel`, `transducer-offset` or `conservative-full-draft` for the eventual
card's assumption label. No new transducer profile field is introduced. DBS
with a retained keel setting is refused, matching the existing Pi depth rule.
No tide, chart datum or provider forecast contributes to these sounder inputs.

Pressure history is bounded to 2,048 strictly increasing measured samples.
Every sample must match the selected feed/source, and the current live pressure
leaf must occur in that history. Existing `observedTendency` supplies the
three-hour-normalized fall, including its 90-minute minimum span and internal
gap checks. Short/gapped/source-swapped histories and forecast-only pressure
remain unknown. No second tendency algorithm is introduced.

## Keeper and delivery integration boundary

`wakeKeeper` returns `phone-only` unless a fresh running report explicitly
identifies update 7 or later, this account, this paired feed and the exact
SHA-256 rule-set digest. A version number, reachable HTTP server, client-side
settings flag, other owner or old rule set does not prove a keeper. This is a
future report validator; the current Pi has no such runner installed by this
checkpoint. Update 7 must add an owned runner and authenticated status/relay
contract before any UI may say Pi-kept.

Ordering is anchor, collision/distress, depth, then other presets. The helper
orders presentation/delivery; it never calls force-stop, releases another
owner's audio token or changes existing watches. The follow-up controller must
use owner-scoped leases and the existing authenticated alarm relay. Arbitrary
Signal K paths, actuator commands and boundary rules remain outside this API.

## Verification and remaining work

`pi-cache/scripts/sync-wake-rule.mjs` mirrors exactly three allowlisted pure
sources, rewrites only their local import suffixes for Node and stamps each
source SHA-256. AST import validation refuses dependency graph expansion;
`--check` and root Vitest tests detect drift. The normal Pi `src/*.test.mts`
glob includes the actual adapter test.

Focused checks cover every preset's comparison/hysteresis, original-clock
confirmation and clear runs, unknown/stale/duplicate/gap/time reversal, quiet
hours, configuration/source changes, keeper identity, depth assumptions,
pressure source history, SI units, ambiguous engines/banks and phone/Pi parity.
The five focused Vitest suites pass 78 checks (35 new rule/input/mirror cases
plus the existing depth and pressure-watch suites); the actual Pi Node adapter
test also passes. The new graph and tests pass a strict scoped TypeScript check,
ESLint and formatting. No full-app compiler or live sensor/device/relay proof is
claimed at this stage.

Pending review: account-scoped persistence/controller, one-screen preset editor,
qualified source discovery, phone lifecycle/audio ownership, update 7's Pi
runner/status and authenticated relay wiring. Each needs its own runtime and
layout proof before the complete 137-01 feature is advertised.
