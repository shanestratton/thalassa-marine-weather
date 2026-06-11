/**
 * services/units.ts — vessel-unit conversion authority.
 *
 * ── THE FEET CONVENTION ─────────────────────────────────────────────
 * `settings.vessel.draft` (and length/beam/airDraft) is stored in FEET.
 * OnboardingWizard's handleFinish converts whatever the user entered to
 * feet before saving (`d_ft = draftUnit === 'm' ? value * 3.28084 : value`
 * — components/OnboardingWizard.tsx), and utils/defaultVessel.ts stores
 * its 1.8 m fallback as 5.9 ft for the same reason.
 *
 * Every routing/depth consumer works in METRES. Reading `vessel.draft`
 * raw treats feet as metres and makes every depth threshold ~3.3× too
 * conservative — a 7.87 ft (2.4 m) draft becomes a 7.87 m cutoff that
 * blocks entire bays (ROUTING_COLLAB ship-blocker #2, "bathymetry is
 * sometimes off"). ALL feet→metres draft conversion goes through
 * `vesselDraftMetres()`; do not hand-roll `vessel.draft || 2.5` again.
 */

export const FEET_PER_METRE = 3.28084;

/**
 * The vessel's draft in METRES, converted from the FEET-stored profile
 * value. Non-finite, zero, or negative drafts (unset profile, observer
 * accounts, corrupted estimates) yield `fallbackM` — 2.5 m matches the
 * long-standing default of every depth consumer (WeatherRoutingService,
 * isochrone engine, HazardQueryService).
 */
export function vesselDraftMetres(vessel: { draft?: number } | undefined | null, fallbackM = 2.5): number {
    const draftFt = vessel?.draft;
    if (typeof draftFt !== 'number' || !Number.isFinite(draftFt) || draftFt <= 0) return fallbackM;
    return draftFt / FEET_PER_METRE;
}
