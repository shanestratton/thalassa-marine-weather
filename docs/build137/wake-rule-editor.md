# Wake rule preferences and editor

The General preferences entry opens one lazy editor with one preset selected at a time. All eight presets start disabled. There is no invented sensor selection or default equipment redline. Sensor reference, physical source and explicit engine/battery instance come from the controller's qualified catalogue. The editor provides threshold, hysteresis, minimum/clear holds and optional quiet hours using an explicit fixed UTC offset. Only Save applies changes.

`services/alarms/wakeRulePreferences.ts` exports the React snapshot hook, synchronous get/subscribe functions and `saveWakeRulePreferences(rules, scope)`. The account-scoped versioned envelope is capped at 32 KiB and contains only eight known presets and supported fields in canonical preset order. Disabled drafts may be incomplete; enabled rules must pass the shared pure model validator. Failed writes do not publish new settings. Corrupt, oversized or unexpectedly missing storage retains the last valid rules in memory for that same account generation, with a visible warning. Another account never inherits them. A newer valid configuration from another window prevents a stale editor overwrite.

`services/alarms/wakeRuleSources.ts` is a memory-only bridge for the controller, not a discovery service. `publishWakeRuleSources(scope, options)` accepts at most 32 unique `{preset, selection, label, measuredAt}` choices. `selection` contains only the opaque verified feed identity, physical source, prescribed reference and explicit engine/bank instance where required. `measuredAt` is the original qualifying leaf/dependency-minimum clock, never catalogue receipt time. Choices expire using the shared preset age limit. Republishing an old reading cannot refresh it. The controller must clear choices when pairing or vessel identity retires; account changes clear them synchronously.

The editor rechecks source clocks when Save is pressed, before the next UI refresh can run. Enabling or reconfiguring an enabled rule needs its currently qualified source. An unchanged existing enabled rule remains saved while its source is unavailable; it can be disabled explicitly. Pressure fall explains that measured history may still be collecting. The current editor says phone watch needs the active app and does not claim Pi keeper coverage. Parent controller/keeper integration must supply fresh owned update-7 capability proof before making that claim.

No arbitrary Signal K path, remote command, provider forecast, inferred physical sender, deployment or server install is added here. Quiet hours suppress only this rule's delivery and require manual UTC-offset updates when clocks change.

Validation is recorded in the integration handoff: focused store/editor tests cover explicit saving, malformed drafts, corrupt storage retention/repair, stale-at-click measurements, unavailable active sources, cross-window conflicts and account retirement. The standard keyboard Playwright suite includes `wake-rules137-layout.spec.ts`, which uses only generated sensors, enlarged text and a simulated keyboard over the real editor and shared keyboard guard. No boat or provider requests are used.

## Editor checkpoint proof

- Vitest: 58/58 passed across `WakeRulePreferences`, `WakeRulesEditor`, `ModalSheet`, `useFocusTrap` and `keyboardScroll`.
- Actual installed Chrome and Playwright WebKit: 6/6 passed, including 300/375 px, 130% text, all eight presets, quiet hours, a simulated 280 px keyboard, bounded scrolling, visible Save and Escape focus return. No external requests occurred. Screenshots were inspected; the native WebKit select surface was corrected using the existing app dropdown styling and complete selected-name captions.
- Full app TypeScript: exit 0; scoped ESLint and Prettier checks pass.
- These checks cover the editor and local storage bridge. Phone alarm delivery and the owned Pi update-7 keeper require their separate runtime integration/proof.
