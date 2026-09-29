/**
 * services/draftConfirmation.ts — has the skipper CONFIRMED the draft?
 *
 * Shane 2026-09-29: the draft is the only boat figure for depth ("we should
 * not need the offset for the transducer. just the draft … lets not make it
 * too complicated for the punter"), and the minimum charted depth is the
 * draft + 0.5 m. A guessed or stale draft therefore decides every depth
 * answer, so before anything plans against it the app asks once: "Your draft
 * is set at 2.40 m. Please confirm."
 *
 * The rule, defined once here:
 *   confirmed ⇔ vessel.draftConfirmedFt equals vessel.draft within 0.01 ft
 *               AND 'draft' is not in vessel.estimatedFields.
 *
 * `draftConfirmedFt` lives on the vessel profile (feet, like `draft` — see
 * services/units.ts, THE FEET CONVENTION), so it syncs with the fleet like
 * every other profile field. Nothing clears it: any later change to the draft
 * (Settings → Vessel, onboarding, a yacht-database estimate) simply stops
 * matching it, which is what makes the draft unconfirmed again.
 *
 * Pure — no store, no React. The shared ask is stores/draftConfirmStore.ts;
 * the one modal is components/vessel/DraftConfirmModal.tsx.
 */
import type { LengthUnit } from '../types/units';
import type { VesselProfile } from '../types/vessel';
import { VESSEL_SETTINGS_SEED } from '../utils/defaultVessel';
import { FEET_PER_METRE } from './units';

/** 0.01 ft = 3 mm: the Vessel tab stores feet to two decimals, so 2.40 m
 *  typed there (7.87 ft) still matches 2.40 m confirmed here (7.874 ft). */
export const DRAFT_CONFIRM_TOLERANCE_FT = 0.01;
/** Sensible bounds for the Change field, in metres. */
export const DRAFT_MIN_M = 0.3;
export const DRAFT_MAX_M = 8;

export type DraftConfirmationStatus =
    /** No usable draft on the profile. */
    | 'unset'
    /** Onboarding or the yacht database guessed it. */
    | 'estimated'
    /** A measured draft nobody has confirmed. */
    | 'unconfirmed'
    /** Confirmed once, changed since. */
    | 'changed'
    | 'confirmed';

export interface DraftConfirmation {
    status: DraftConfirmationStatus;
    /** The stored draft in feet; null when unset. */
    draftFt: number | null;
    /** The same draft in metres; null when unset. */
    draftM: number | null;
}

type DraftFields = Partial<Pick<VesselProfile, 'draft' | 'estimatedFields' | 'draftConfirmedFt'>>;

const usableFeet = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

export function draftConfirmation(vessel: DraftFields | null | undefined): DraftConfirmation {
    const draftFt = usableFeet(vessel?.draft);
    if (draftFt === null) return { status: 'unset', draftFt: null, draftM: null };
    const draftM = draftFt / FEET_PER_METRE;
    if (vessel?.estimatedFields?.includes('draft')) return { status: 'estimated', draftFt, draftM };
    const confirmedFt = vessel?.draftConfirmedFt;
    if (typeof confirmedFt !== 'number' || !Number.isFinite(confirmedFt))
        return { status: 'unconfirmed', draftFt, draftM };
    // The epsilon keeps an exact 0.01 ft step on the confirmed side of float error.
    const same = Math.abs(confirmedFt - draftFt) <= DRAFT_CONFIRM_TOLERANCE_FT + 1e-9;
    return { status: same ? 'confirmed' : 'changed', draftFt, draftM };
}

export function isDraftConfirmed(vessel: DraftFields | null | undefined): boolean {
    return draftConfirmation(vessel).status === 'confirmed';
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** "2.40 m" — metres, two decimals. */
export function formatDraftMetres(draftFt: number): string {
    return `${(draftFt / FEET_PER_METRE).toFixed(2)} m`;
}

/** "2.40 m", or "7.87 ft (2.40 m)" when the skipper's draft unit is feet. */
export function formatDraft(draftFt: number, unit: LengthUnit): string {
    const metres = formatDraftMetres(draftFt);
    return unit === 'ft' ? `${draftFt.toFixed(2)} ft (${metres})` : metres;
}

/** The Vessel tab's own rule for the draft's unit (components/settings/VesselTab.tsx). */
export function draftDisplayUnit(settings: {
    vesselUnits?: { draft?: LengthUnit };
    units?: { length?: LengthUnit };
}): LengthUnit {
    return settings.vesselUnits?.draft || settings.units?.length || 'ft';
}

/** The Change field's starting text: metres to two decimals, or empty. */
export function draftInputValue(draftFt: number | null): string {
    return draftFt !== null && draftFt > 0 ? (draftFt / FEET_PER_METRE).toFixed(2) : '';
}

export type DraftInput = { ok: true; metres: number } | { ok: false; error: string };

/** Metres typed in the Change field, rounded to two decimals and bounded. */
export function parseDraftMetres(text: string): DraftInput {
    const trimmed = text.trim().replace(',', '.');
    if (!trimmed) return { ok: false, error: 'Enter your draft in metres.' };
    // A minus sign is a number out of bounds, not a typing error.
    if (!/^-?(\d+\.?\d*|\.\d+)$/.test(trimmed)) return { ok: false, error: 'Enter your draft in metres, like 1.80.' };
    const metres = round2(Number(trimmed));
    if (!(metres >= DRAFT_MIN_M && metres <= DRAFT_MAX_M))
        return {
            ok: false,
            error: `Enter a draft between ${DRAFT_MIN_M.toFixed(2)} m and ${DRAFT_MAX_M.toFixed(2)} m.`,
        };
    return { ok: true, metres };
}

/**
 * The profile patch that confirms the draft — the current one (no argument),
 * or `enteredMetres` from the Change field. Feet, as stored. Confirming an
 * estimate makes it the skipper's own, so 'draft' leaves estimatedFields.
 *
 * A figure that reads the same in the field (7.87 ft shows as 2.40) keeps
 * the stored feet: saving the prefilled value must not rewrite it.
 */
export function confirmDraftPatch(
    vessel: DraftFields | null | undefined,
    enteredMetres?: number,
): Pick<Partial<VesselProfile>, 'draft' | 'draftConfirmedFt' | 'estimatedFields'> {
    const currentFt = usableFeet(vessel?.draft);
    let draftFt: number;
    if (enteredMetres === undefined) {
        if (currentFt === null) throw new Error('No draft to confirm.');
        draftFt = currentFt;
    } else {
        const unchanged = currentFt !== null && round2(currentFt / FEET_PER_METRE) === round2(enteredMetres);
        draftFt = unchanged ? currentFt : enteredMetres * FEET_PER_METRE;
    }
    const estimated = vessel?.estimatedFields;
    return {
        ...(draftFt !== currentFt ? { draft: draftFt } : {}),
        draftConfirmedFt: draftFt,
        ...(estimated?.includes('draft') ? { estimatedFields: estimated.filter((field) => field !== 'draft') } : {}),
    };
}

/** The figures a draft save guesses when there is no boat behind the draft. */
const GUESSED_WITH_THE_DRAFT = ['length', 'beam', 'displacement', 'maxWaveHeight', 'cruisingSpeed'] as const;

const hasFigure = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value > 0;

/**
 * The profile patch the draft modal saves (review 2026-09-29).
 *
 * With a boat behind the draft — any figure of her own — it is the
 * confirmation patch itself, and nothing else changes.
 *
 * With none — no profile at all (routing runs on DEFAULT_VESSEL then), or one
 * with no figure in it (the released-hull placeholder, a fresh 'New Vessel')
 * — saving the draft alone would make a boat of zeros: the day planner
 * refuses a 0 kt boat, the departure window reads a 0 m wave cap, and the
 * next sign-in bootstraps those zeros to the fleet. So the rest of the boat
 * comes from the Vessel tab's own starting figures (VESSEL_SETTINGS_SEED),
 * marked in estimatedFields so the Vessel tab shows them as guesses and the
 * planner says its times are estimates. The draft is the skipper's own; the
 * seed's placeholder draft never survives. A crew member's profile
 * ('observer') is not a boat to guess at.
 */
export function draftSaveProfilePatch(
    vessel: VesselProfile | null | undefined,
    patch: Partial<VesselProfile>,
): Partial<VesselProfile> {
    if (vessel?.type === 'observer') return patch;
    if (vessel && [...GUESSED_WITH_THE_DRAFT, 'draft' as const].some((field) => hasFigure(vessel[field]))) return patch;
    const guessed = Object.fromEntries(GUESSED_WITH_THE_DRAFT.map((field) => [field, VESSEL_SETTINGS_SEED[field]]));
    const estimated = new Set([...(patch.estimatedFields ?? vessel?.estimatedFields ?? []), ...GUESSED_WITH_THE_DRAFT]);
    estimated.delete('draft');
    return {
        ...(vessel ? {} : { ...VESSEL_SETTINGS_SEED, draft: 0 }),
        ...(vessel?.name?.trim() ? {} : { name: VESSEL_SETTINGS_SEED.name }),
        ...guessed,
        ...patch,
        estimatedFields: [...estimated],
    };
}
