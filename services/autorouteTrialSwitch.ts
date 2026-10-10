/**
 * Auto route (trial): the skipper's own switch for Thalassa's router in the
 * Auto workspace only (2026-10-01). Off by default.
 *
 * Phase 3 (3b606808) replaced the old server trial gate (Shane's allowlist, a
 * kill switch, an expiry) with a local one: Pro, signed in, installed charts.
 * Pro is every account while the public beta is on (PUBLIC_BETA_ACCESS), so
 * that gate opened Auto to every tester with charts. A router built that week
 * must not reach them before Shane has proved it in the Whitsundays, so Auto
 * stays closed until Settings → Preferences → "Auto route (trial)" is on, and
 * when closed it says where the switch is. Claude's call under Shane's
 * delegation (2026-10-01: "any questions please answer with whatever your
 * recommendation is").
 *
 * Plan Your Day read it until build 124 ("Today on the water") and reads it
 * again since 127-PYD-2: the stop she opens is routed through Auto's own
 * provider (owner-only in 127, services/dayPlanner/pydRouting.ts), behind
 * this same switch, and its stop page turns it on in place.
 *
 * Stored with the other Preferences switches (UserSettings, per account).
 * The manual planner's ⚡ Auto route and the passage planner do not read it.
 */
import { useSettingsStore } from '../stores/settingsStore';

/** What Auto says while the switch is off. */
export const AUTO_ROUTE_TRIAL_OFF = 'Auto route (trial) is off. Turn it on in Settings → Preferences. Manual is ready.';

/** Whether the skipper has switched Auto route (trial) on. Off unless set. */
export function isAutorouteTrialOn(): boolean {
    return useSettingsStore.getState().settings.autorouteTrialEnabled === true;
}

/** The same, for a component that should close the moment it is switched off. */
export function useAutorouteTrialOn(): boolean {
    return useSettingsStore((state) => state.settings.autorouteTrialEnabled === true);
}
