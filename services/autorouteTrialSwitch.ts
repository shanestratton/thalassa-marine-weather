/**
 * Auto route (trial): the skipper's own switch for Thalassa's router in Auto
 * routing and Plan Your Day (2026-10-01). Off by default.
 *
 * Phase 3 (3b606808) replaced the old server trial gate (Shane's allowlist, a
 * kill switch, an expiry) with a local one: Pro, signed in, installed charts.
 * Pro is every account while the public beta is on (PUBLIC_BETA_ACCESS), so
 * that gate opened Auto and Plan Your Day to every tester with charts. A
 * router built that week must not reach them before Shane has proved it in
 * the Whitsundays, so both stay closed until Settings → Preferences →
 * "Auto route (trial)" is on, and when closed they say where the switch is.
 * Claude's call under Shane's delegation (2026-10-01: "any questions please
 * answer with whatever your recommendation is").
 *
 * Stored with the other Preferences switches (UserSettings, per account).
 * The manual planner's ⚡ Auto route and the passage planner do not read it.
 */
import { useSettingsStore } from '../stores/settingsStore';

/** What Auto says while the switch is off. */
export const AUTO_ROUTE_TRIAL_OFF = 'Auto route (trial) is off. Turn it on in Settings → Preferences. Manual is ready.';
/** What Plan Your Day says while the switch is off. */
export const PLAN_YOUR_DAY_TRIAL_OFF =
    'Plan Your Day routes with Auto route (trial), which is off. Turn it on in Settings → Preferences.';

/** Whether the skipper has switched Auto route (trial) on. Off unless set. */
export function isAutorouteTrialOn(): boolean {
    return useSettingsStore.getState().settings.autorouteTrialEnabled === true;
}

/** The same, for a component that should close the moment it is switched off. */
export function useAutorouteTrialOn(): boolean {
    return useSettingsStore((state) => state.settings.autorouteTrialEnabled === true);
}
