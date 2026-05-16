// Default vessel profile — used by route planning when the user
// hasn't configured a personal vessel yet.
//
// Why this exists
// ----------------
// Before this, tapping "Slide to Calculate Route" without a saved
// vessel threw "Vessel profile missing. Please configure in
// settings." A fresh-install user wanting to plan their first
// route hit a brick wall asking them to fill out a 12-field form
// before they could see the product work — friction at exactly
// the moment they were trying to use the app's core feature.
//
// The fix is the same shape as the deferred-sign-in flow (PR1):
// move the friction from BEFORE-the-action to AS-LATE-AS-NEEDED.
// Everyone gets a sensible generic cruising-sailboat profile by
// default; users with their own boat can refine it in Settings →
// Vessel for personalised routing/ETAs.
//
// Profile shape
// --------------
// Generic 35ft monohull sloop — the workhorse of recreational
// cruising. Numbers chosen to be conservative-but-realistic:
//   - 6 kt cruising speed (typical sailboat average)
//   - 1.8 m draft (avoids most shallow water but assumes monohull)
//   - 25 kt max sustained wind (comfortable cruising threshold)
//   - 2.5 m max wave height (~8 ft seas — beyond this, most
//     cruisers reef hard or wait)
//
// These produce sensible isochrone routes for the average punter.
// When the user sets their own vessel (Settings → Vessel) those
// values take over.

import type { VesselProfile } from '../types/vessel';

export const DEFAULT_VESSEL: VesselProfile = {
    name: 'Default Cruiser',
    type: 'sail',
    riggingType: 'Sloop',
    hullType: 'monohull',
    length: 35,
    beam: 11,
    draft: 5.9, // 1.8m in feet — VesselProfile stores draft in feet (see project_vessel_draft_is_feet memory)
    displacement: 7500, // kg, ~16,500 lb
    airDraft: 50, // feet — typical 35ft sloop mast height
    maxWaveHeight: 2.5, // metres
    maxWindSpeed: 25, // knots
    cruisingSpeed: 6, // knots
    // Optional fields left undefined — the routing engine handles
    // missing values with sensible per-field defaults.
};

/**
 * Returns the user's configured vessel if present, otherwise the
 * generic default. Always returns a value — no caller has to handle
 * `null` / "vessel missing" any more.
 */
export function resolveEffectiveVessel(vessel: VesselProfile | null | undefined): VesselProfile {
    return vessel ?? DEFAULT_VESSEL;
}

/** True when the routing pipeline is running on the generic
 *  default instead of a user-configured vessel. Surfaces a small
 *  "Default profile" pill in the planner so the user knows they
 *  CAN personalise this but don't HAVE to. */
export function isUsingDefaultVessel(vessel: VesselProfile | null | undefined): boolean {
    return !vessel;
}
