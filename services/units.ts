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

/**
 * The vessel's AIR DRAFT (mast height above waterline) in METRES, converted
 * from the FEET-stored profile value. Returns NULL when unset/zero/invalid —
 * unlike draft there is NO safe fallback: assuming a tall mast would block
 * powerboats under every bridge, assuming a short one would send a sailboat
 * under a fixed bridge. Null means "no clearance gating" and consumers must
 * treat it that way.
 */
export function vesselAirDraftMetres(vessel: { airDraft?: number } | undefined | null): number | null {
    const airFt = vessel?.airDraft;
    if (typeof airFt !== 'number' || !Number.isFinite(airFt) || airFt <= 0) return null;
    return airFt / FEET_PER_METRE;
}

/**
 * ── THE DERIVED PERFORMANCE FIGURES ─────────────────────────────────
 * `maxWaveHeight` and `cruisingSpeed` are the settings panel's
 * "Performance (Auto)" pair: derived from the hull, never typed by the
 * skipper. They used to be computed once during onboarding and then
 * stored, which produced two failures.
 *
 * First, a profile rehydrated from the vessel fleet came back with both
 * at 0 — `boat_profiles.profile` has no such keys, and profileDefaults
 * coerces a missing number to 0. That zero then reaches every consumer,
 * because settingsWithFleetVessel replaces `settings.vessel` wholesale.
 *
 * Second, every call site guarded with `existing || compute`, so once a
 * value was stored it never tracked a later change to LOA — a skipper
 * correcting their length kept the old boat's numbers forever.
 *
 * Zero is never a safe answer for either. isochroneEnhancer gates its
 * survivability limit on `vessel.maxWindSpeed || vessel.maxWaveHeight`,
 * so a zero max wave silently REMOVES the "what can this boat take"
 * ceiling instead of tightening it. Derive on read; treat an explicitly
 * stored positive value as an override so a hand-tuned profile still wins.
 */

/** Multipliers on LOA. Multihulls carry their beam through a bigger sea. */
const MAX_WAVE_RATIO_BY_HULL: Record<string, number> = {
    catamaran: 0.45,
    trimaran: 0.5,
};
const MAX_WAVE_RATIO_MONOHULL = 0.35;

/**
 * The vessel's workable maximum wave height in FEET (the unit the panel
 * renders). Returns `fallbackFt` only when there is no usable length to
 * derive from — an observer account or a profile that never had one.
 */
export function vesselMaxWaveHeightFt(
    vessel: { maxWaveHeight?: number; length?: number; hullType?: string } | undefined | null,
    fallbackFt = 0,
): number {
    const stored = vessel?.maxWaveHeight;
    if (typeof stored === 'number' && Number.isFinite(stored) && stored > 0) return stored;

    const lengthFt = vessel?.length;
    if (typeof lengthFt !== 'number' || !Number.isFinite(lengthFt) || lengthFt <= 0) return fallbackFt;

    const ratio = MAX_WAVE_RATIO_BY_HULL[vessel?.hullType ?? ''] ?? MAX_WAVE_RATIO_MONOHULL;
    return lengthFt * ratio;
}

/**
 * The vessel's cruising speed in KNOTS. Sail boats are hull-speed bound;
 * power boats are not, hence the far larger coefficient. Returns
 * `fallbackKts` only when there is no usable length to derive from.
 */
export function vesselCruisingSpeedKts(
    vessel: { cruisingSpeed?: number; length?: number; type?: string } | undefined | null,
    fallbackKts = 0,
): number {
    const stored = vessel?.cruisingSpeed;
    if (typeof stored === 'number' && Number.isFinite(stored) && stored > 0) return stored;

    const lengthFt = vessel?.length;
    if (typeof lengthFt !== 'number' || !Number.isFinite(lengthFt) || lengthFt <= 0) return fallbackKts;

    return Math.sqrt(lengthFt) * (vessel?.type === 'sail' ? 1.2 : 3);
}
