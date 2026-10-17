/**
 * seaComfort — one beta word for how the sea will feel aboard (build 130,
 * 130-04): Comfortable, Lively, Uncomfortable or Hard going, with the one
 * input that set it. It describes COMFORT, never safety. Glass, the HUD and
 * departure comparisons share this pure model. The optional141-06 personal
 * preference is bounded and qualified from private genuine passage reports.
 *
 * The inputs, each a level 0-3, the word being the highest any reaches:
 *   - Hs / LWL, the total sea against her waterline: Lively from 0.06,
 *     Uncomfortable from 0.12, Hard going from 0.20.
 *   - The wind sea's steepness, Hs / L with L = 1.56 T² (deep water):
 *     Uncomfortable from 0.05, Hard going from 0.07.
 *   - The pitching band: waves 0.75-1.5 × her waterline, +1 level once
 *     Hs / LWL is 0.05 or more.
 *   - A cross sea: wind sea and swell each 0.5 m or more, 45° or more apart:
 *     +1 level.
 *   - WMO code 3700 sets floors: Rough (2.5 m or more) is never better than
 *     Uncomfortable; Very rough or worse (4 m or more) is always Hard going.
 * Provisional beta thresholds; uncalibrated until the explicit report floor.
 *
 * No profile, or an observer's: a labelled generic 38 ft boat, waterline 10 m.
 * A profile: LWL ≈ 0.85 × her length overall (`length` is LOA in feet).
 * No period: no word ("Comfort needs a wave period"), never a guess.
 */
import type { VesselProfile } from '../types';
/** Bounded private subjective preference. No identity, storage or service dependency;
 * safe as an explicit routing-worker input. This is never weather skill. */
export const PERSONAL_COMFORT_INPUTS = ['size', 'steepness', 'pitching', 'cross'] as const;
export type PersonalComfortInput = (typeof PERSONAL_COMFORT_INPUTS)[number];
export interface ComfortPreference {
    schema: 1;
    profile: { type: 'sail' | 'power'; length: number; revision: number };
    adjustments: Record<PersonalComfortInput, -1 | 0 | 1>;
    qualified: Record<PersonalComfortInput, { reports: number; voyages: number }>;
}
export function comfortPreferenceLabel(
    preference: ComfortPreference | null | undefined,
    input: string | null | undefined,
): string {
    const count =
        input && PERSONAL_COMFORT_INPUTS.includes(input as PersonalComfortInput)
            ? preference?.qualified[input as PersonalComfortInput]
            : null;
    return count && count.reports >= 6 && count.voyages >= 3 ? 'personal preference beta' : 'uncalibrated beta';
}
export function validComfortPreference(
    value: unknown,
    vessel?: { type: string; length: number } | null,
): value is ComfortPreference {
    if (!value || typeof value !== 'object' || !vessel) return false;
    const p = value as Partial<ComfortPreference>;
    if (
        p.schema !== 1 ||
        !p.profile ||
        !['sail', 'power'].includes(p.profile.type) ||
        p.profile.type !== vessel.type ||
        p.profile.length !== vessel.length ||
        !Number.isFinite(p.profile.length) ||
        !(p.profile.length > 0 && p.profile.length <= 1000) ||
        !Number.isSafeInteger(p.profile.revision) ||
        p.profile.revision < 1 ||
        !p.adjustments ||
        !p.qualified
    )
        return false;
    return PERSONAL_COMFORT_INPUTS.every((key) => {
        const count = p.qualified![key],
            adjustment = p.adjustments![key];
        return (
            [-1, 0, 1].includes(adjustment) &&
            !!count &&
            Number.isInteger(count.reports) &&
            count.reports >= 0 &&
            count.reports <= 120 &&
            Number.isInteger(count.voyages) &&
            count.voyages >= 0 &&
            count.voyages <= count.reports &&
            (adjustment === 0 || (count.reports >= 6 && count.voyages >= 3))
        );
    });
}

export type ComfortWord = 'Comfortable' | 'Lively' | 'Uncomfortable' | 'Hard going';

/** One part of the sea, metres, seconds and degrees FROM (services/weather/seaPartitions SeaPart). */
export interface ComfortPart {
    hM: number;
    periodS: number | null;
    fromDeg: number | null;
}
export function validComfortPart(value: unknown): value is ComfortPart | null {
    if (value === null) return true;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const p = value as Partial<ComfortPart>;
    return (
        typeof p.hM === 'number' &&
        Number.isFinite(p.hM) &&
        p.hM >= 0 &&
        p.hM <= 50 &&
        (p.periodS === null ||
            (typeof p.periodS === 'number' && Number.isFinite(p.periodS) && p.periodS > 0 && p.periodS <= 60)) &&
        (p.fromDeg === null ||
            (typeof p.fromDeg === 'number' && Number.isFinite(p.fromDeg) && p.fromDeg >= 0 && p.fromDeg <= 360))
    );
}

export interface ComfortParts {
    total: ComfortPart | null;
    windSea: ComfortPart | null;
    swell: ComfortPart | null;
}

/** Which input set the word (141-06 calibrates each). */
export type ComfortInput = 'size' | 'steepness' | 'pitching' | 'cross' | 'wmo';

export interface SeaComfort {
    /** Null when the sea lacks what the word needs (see `reason`). */
    word: ComfortWord | null;
    /** The input that set the word, or why there is none. */
    reason: string;
    /** That input; null with no word. */
    input: ComfortInput | null;
    /** No profile: judged for the generic 38 ft boat. */
    generic: boolean;
    /** The waterline it was judged on, metres. */
    lwlM: number;
}

export const GENERIC_LWL_M = 10;
export const GENERIC_BOAT_LABEL = 'generic 38 ft boat';
export const COMFORT_NEEDS_PERIOD = 'Comfort needs a wave period';

const WORDS: readonly ComfortWord[] = ['Comfortable', 'Lively', 'Uncomfortable', 'Hard going'];
/** A part under this is none (seaPartitions SEA_PART_NONE_M). */
const NONE_M = 0.1;
const FT_TO_M = 0.3048;

/** Deep-water wavelength for a period, metres. */
const wavelengthM = (periodS: number): number => 1.56 * periodS * periodS;

/** Her estimated waterline, metres; null for no boat to judge (no profile, an observer, no length). */
export function waterlineM(vessel?: Pick<VesselProfile, 'type' | 'length'> | null): number | null {
    if (
        !vessel ||
        vessel.type === 'observer' ||
        !Number.isFinite(vessel.length) ||
        !(vessel.length > 0 && vessel.length <= 1000)
    )
        return null;
    return 0.85 * vessel.length * FT_TO_M;
}

function apartDeg(a: number, b: number): number {
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
}

export function seaComfort(
    parts: ComfortParts,
    vessel?: Pick<VesselProfile, 'type' | 'length'> | null,
    preference?: ComfortPreference | null,
): SeaComfort | null {
    if (!parts) return null;
    const { total } = parts;
    if (!total || !validComfortPart(total) || !validComfortPart(parts.windSea) || !validComfortPart(parts.swell))
        return null;
    const own = waterlineM(vessel);
    const lwlM = own ?? GENERIC_LWL_M;
    const generic = own === null;
    const windSea = parts.windSea && parts.windSea.hM >= NONE_M ? parts.windSea : null;
    if (!total.periodS || (windSea && !windSea.periodS))
        return { word: null, reason: COMFORT_NEEDS_PERIOD, input: null, generic, lwlM };

    // Size against her waterline.
    const size = total.hM / lwlM;
    let level = size >= 0.2 ? 3 : size >= 0.12 ? 2 : size >= 0.06 ? 1 : 0;
    let reason =
        level === 0
            ? 'small sea for her length'
            : level === 1
              ? 'moderate sea for her length'
              : 'big sea for her length';
    let input: ComfortInput = 'size';

    // A short, steep wind sea.
    if (windSea?.periodS) {
        const steep = windSea.hM / wavelengthM(windSea.periodS);
        const steepLevel = steep >= 0.07 ? 3 : steep >= 0.05 ? 2 : 0;
        if (steepLevel > 0 && steepLevel >= level) {
            level = steepLevel;
            reason = 'short, steep wind sea';
            input = 'steepness';
        }
    }

    // Waves about her length: she pitches. Each +1 below names itself only
    // when it raises the word: past Hard going it changes nothing, and the
    // reason stays the input that set the word (141-06 calibrates by it).
    const lambda = wavelengthM(total.periodS);
    if (level < 3 && size >= 0.05 && lambda >= 0.75 * lwlM && lambda <= 1.5 * lwlM) {
        level += 1;
        reason = 'waves about her length: pitching';
        input = 'pitching';
    }

    // A cross sea.
    const swell = parts.swell;
    if (
        level < 3 &&
        windSea &&
        swell &&
        windSea.hM >= 0.5 &&
        swell.hM >= 0.5 &&
        windSea.fromDeg !== null &&
        swell.fromDeg !== null &&
        apartDeg(windSea.fromDeg, swell.fromDeg) >= 45
    ) {
        level += 1;
        reason = 'cross sea';
        input = 'cross';
    }

    // A bounded personal preference may change the dominant physical input
    // by one word. The rough-sea floors below always remain authoritative.
    if (validComfortPreference(preference, vessel)) {
        const adjustment = preference.adjustments[input];
        if (adjustment) {
            level = Math.max(0, Math.min(3, level + adjustment));
            reason += ' · personal preference';
        }
    }
    // WMO 3700's two comfort floors, directly in metres. This pure helper
    // also runs in the routing Worker; importing the display formatters
    // would couple the route-job closure back to everyday app screens.
    const floor = total.hM < 2.5 ? 0 : total.hM < 4 ? 2 : 3;
    if (floor === 3 && level < 3) {
        level = 3;
        reason = 'very rough sea (WMO)';
        input = 'wmo';
    } else if (floor === 2 && level < 2) {
        level = 2;
        reason = 'rough sea (WMO)';
        input = 'wmo';
    }
    return { word: WORDS[level], reason, input, generic, lwlM };
}

/** Deep-water wave power, P ≈ 0.49 · Hs² · T kW per metre of wave front; null without a period. */
export function wavePowerKwPerM(total: ComfortPart | null): number | null {
    if (!total || !total.periodS) return null;
    return 0.49 * total.hM * total.hM * total.periodS;
}

/** "≈ 12 kW/m wave power (approx.)": whole kW/m, one decimal under 10. */
export function formatWavePower(kw: number): string {
    const tenths = Math.round(kw * 10) / 10;
    const shown = tenths < 0.1 ? '< 0.1' : tenths < 10 ? `≈ ${tenths.toFixed(1)}` : `≈ ${Math.round(kw)}`;
    return `${shown} kW/m wave power (approx.)`;
}

/** What the wave power is, for the bubble's help text. */
export const WAVE_POWER_HELP = "The sea's energy per metre of wave front, in deep water. Not a safety number.";
