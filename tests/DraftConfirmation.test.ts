/**
 * The draft confirmation rule (Shane 2026-09-29): the draft is the only boat
 * figure for depth, so before anything plans against it the skipper confirms
 * it once. Confirmed iff the confirmed figure equals the current draft within
 * 0.01 ft AND the draft is not an estimate. Pure logic, no store.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { VesselProfile } from '../types/vessel';
import {
    DRAFT_CONFIRM_TOLERANCE_FT,
    DRAFT_MAX_M,
    DRAFT_MIN_M,
    confirmDraftPatch,
    draftConfirmation,
    draftDisplayUnit,
    draftInputValue,
    draftSaveProfilePatch,
    formatDraft,
    formatDraftMetres,
    isDraftConfirmed,
    parseDraftMetres,
} from '../services/draftConfirmation';
import { FEET_PER_METRE, vesselMaxWaveHeightMetres } from '../services/units';
import { defaultVesselProfile } from '../services/VesselFleetService';
import { VESSEL_SETTINGS_SEED, vesselWithSettingsDefaults } from '../utils/defaultVessel';

const FT_2_40 = 2.4 * FEET_PER_METRE; // 7.874016 ft

describe('draftConfirmation — the five states', () => {
    it('unset: no vessel, zero, negative or non-numeric draft', () => {
        for (const vessel of [undefined, null, {}, { draft: 0 }, { draft: -1 }, { draft: Number.NaN }]) {
            expect(draftConfirmation(vessel).status).toBe('unset');
            expect(draftConfirmation(vessel).draftFt).toBeNull();
            expect(draftConfirmation(vessel).draftM).toBeNull();
            expect(isDraftConfirmed(vessel)).toBe(false);
        }
        // Even a stale confirmation cannot confirm a missing draft.
        expect(isDraftConfirmed({ draft: 0, draftConfirmedFt: 0 })).toBe(false);
    });

    it('unconfirmed: a measured draft nobody has confirmed yet', () => {
        const state = draftConfirmation({ draft: FT_2_40 });
        expect(state.status).toBe('unconfirmed');
        expect(state.draftFt).toBe(FT_2_40);
        expect(state.draftM).toBeCloseTo(2.4, 10);
        expect(isDraftConfirmed({ draft: FT_2_40 })).toBe(false);
    });

    it('estimated: onboarding guesses are never confirmed, even with a matching confirmation', () => {
        const vessel = { draft: FT_2_40, estimatedFields: ['beam', 'draft'], draftConfirmedFt: FT_2_40 };
        expect(draftConfirmation(vessel).status).toBe('estimated');
        expect(isDraftConfirmed(vessel)).toBe(false);
        // Another field being estimated does not matter.
        expect(isDraftConfirmed({ ...vessel, estimatedFields: ['beam'] })).toBe(true);
    });

    it('confirmed: equal within 0.01 ft', () => {
        expect(isDraftConfirmed({ draft: FT_2_40, draftConfirmedFt: FT_2_40 })).toBe(true);
        expect(DRAFT_CONFIRM_TOLERANCE_FT).toBe(0.01);
        // 7.87 ft typed in Settings vs 2.40 m (7.874016 ft) confirmed: 0.004 ft apart.
        expect(isDraftConfirmed({ draft: 7.87, draftConfirmedFt: FT_2_40 })).toBe(true);
        expect(isDraftConfirmed({ draft: FT_2_40 + 0.01, draftConfirmedFt: FT_2_40 })).toBe(true);
        expect(draftConfirmation({ draft: FT_2_40, draftConfirmedFt: FT_2_40 }).status).toBe('confirmed');
    });

    it('changed after confirm: any later change beyond 0.01 ft makes it unconfirmed again', () => {
        const confirmed = { draft: FT_2_40, draftConfirmedFt: FT_2_40 };
        // Settings → Vessel: 2.40 m → 2.50 m.
        const changed = { ...confirmed, draft: 2.5 * FEET_PER_METRE };
        expect(draftConfirmation(changed).status).toBe('changed');
        expect(isDraftConfirmed(changed)).toBe(false);
        expect(isDraftConfirmed({ ...confirmed, draft: FT_2_40 + 0.011 })).toBe(false);
        expect(isDraftConfirmed({ ...confirmed, draft: FT_2_40 - 0.02 })).toBe(false);
        // Onboarding re-estimating the draft.
        expect(draftConfirmation({ ...confirmed, estimatedFields: ['draft'] }).status).toBe('estimated');
        // A corrupt confirmation is not a confirmation.
        expect(isDraftConfirmed({ draft: FT_2_40, draftConfirmedFt: Number.NaN })).toBe(false);
    });
});

describe('formatting — metres to 2 decimals, feet too for imperial users', () => {
    it('shows metres with two decimals', () => {
        expect(formatDraftMetres(FT_2_40)).toBe('2.40 m');
        expect(formatDraftMetres(7.87)).toBe('2.40 m');
        expect(formatDraftMetres(5.9)).toBe('1.80 m');
        expect(formatDraft(FT_2_40, 'm')).toBe('2.40 m');
    });

    it('shows feet then metres when the draft unit is feet', () => {
        expect(formatDraft(FT_2_40, 'ft')).toBe('7.87 ft (2.40 m)');
        expect(formatDraft(5.9, 'ft')).toBe('5.90 ft (1.80 m)');
    });

    it('follows the Vessel tab: vessel draft unit, else length preference, else feet', () => {
        expect(draftDisplayUnit({ vesselUnits: { draft: 'm' }, units: { length: 'ft' } })).toBe('m');
        expect(draftDisplayUnit({ vesselUnits: { draft: 'ft' }, units: { length: 'm' } })).toBe('ft');
        expect(draftDisplayUnit({ units: { length: 'm' } })).toBe('m');
        expect(draftDisplayUnit({})).toBe('ft');
    });

    it('prefills the metres field with two decimals, empty when unset', () => {
        expect(draftInputValue(FT_2_40)).toBe('2.40');
        expect(draftInputValue(7.87)).toBe('2.40');
        expect(draftInputValue(null)).toBe('');
    });
});

describe('parseDraftMetres — the Change field', () => {
    it('accepts metres with up to two decimals, and a decimal comma', () => {
        expect(parseDraftMetres('2.4')).toEqual({ ok: true, metres: 2.4 });
        expect(parseDraftMetres(' 2,45 ')).toEqual({ ok: true, metres: 2.45 });
        expect(parseDraftMetres('.9')).toEqual({ ok: true, metres: 0.9 });
        expect(parseDraftMetres('3.')).toEqual({ ok: true, metres: 3 });
        // More decimals than the field shows round to two.
        expect(parseDraftMetres('2.456')).toEqual({ ok: true, metres: 2.46 });
    });

    it('keeps to sensible bounds with a plain error', () => {
        expect(DRAFT_MIN_M).toBe(0.3);
        expect(DRAFT_MAX_M).toBe(8);
        expect(parseDraftMetres('0.3')).toEqual({ ok: true, metres: 0.3 });
        expect(parseDraftMetres('8')).toEqual({ ok: true, metres: 8 });
        for (const text of ['0.29', '8.01', '0', '-1', '24'])
            expect(parseDraftMetres(text)).toEqual({ ok: false, error: 'Enter a draft between 0.30 m and 8.00 m.' });
    });

    it('rejects empty and non-numeric input', () => {
        expect(parseDraftMetres('')).toEqual({ ok: false, error: 'Enter your draft in metres.' });
        expect(parseDraftMetres('   ')).toEqual({ ok: false, error: 'Enter your draft in metres.' });
        for (const text of ['abc', '2.4m', '1..2', '2.4.1', '7 ft'])
            expect(parseDraftMetres(text)).toEqual({ ok: false, error: 'Enter your draft in metres, like 1.80.' });
    });
});

describe('confirmDraftPatch — what Confirm and Save write (feet, as stored)', () => {
    it('Confirm writes the stored figure as confirmed, untouched', () => {
        expect(confirmDraftPatch({ draft: 7.87 })).toEqual({ draftConfirmedFt: 7.87 });
        const patched = { draft: 7.87, ...confirmDraftPatch({ draft: 7.87 }) };
        expect(isDraftConfirmed(patched)).toBe(true);
    });

    it('confirming an estimated draft removes draft from estimatedFields only', () => {
        const vessel = { draft: 6.4, estimatedFields: ['beam', 'draft', 'displacement'] };
        const patch = confirmDraftPatch(vessel);
        expect(patch).toEqual({ draftConfirmedFt: 6.4, estimatedFields: ['beam', 'displacement'] });
        expect(isDraftConfirmed({ ...vessel, ...patch })).toBe(true);
    });

    it('Save writes the new metres as feet and confirms exactly that figure', () => {
        const patch = confirmDraftPatch({ draft: 5.9 }, 2.4);
        expect(patch.draft).toBeCloseTo(FT_2_40, 10);
        expect(patch.draftConfirmedFt).toBe(patch.draft);
        const saved = { draft: 5.9, ...patch };
        expect(isDraftConfirmed(saved)).toBe(true);
        // Round trip: the metres the skipper typed are the metres routing uses.
        expect(saved.draft / FEET_PER_METRE).toBeCloseTo(2.4, 10);
    });

    it('saving the prefilled value unchanged keeps the stored feet (no rounding drift)', () => {
        // 7.87 ft shows as 2.40; saving "2.40" must not rewrite it as 7.874016.
        const patch = confirmDraftPatch({ draft: 7.87, estimatedFields: ['draft'] }, 2.4);
        expect(patch).toEqual({ draftConfirmedFt: 7.87, estimatedFields: [] });
        expect(patch).not.toHaveProperty('draft');
    });

    it('Save sets a draft where none was set', () => {
        const patch = confirmDraftPatch(undefined, 1.8);
        expect(patch.draft).toBeCloseTo(1.8 * FEET_PER_METRE, 10);
        expect(patch.draftConfirmedFt).toBe(patch.draft);
        expect(patch).not.toHaveProperty('estimatedFields');
    });

    it('Confirm with nothing to confirm is refused', () => {
        expect(() => confirmDraftPatch({ draft: 0 })).toThrow(/No draft/);
    });
});

describe('the confirmation rides the vessel profile through the fleet', () => {
    it('a cloud row keeps draftConfirmedFt, so a confirmed draft stays confirmed on the next device', async () => {
        // Guard, not new code: the fleet parser keeps unknown profile keys and
        // the server merges profile JSON with ||, so no migration is needed.
        const { normalizeVesselFleetPayload } = await import('../services/VesselFleetService');
        const fleet = normalizeVesselFleetPayload(
            [
                {
                    id: 'boat-1',
                    owner_id: 'owner-1',
                    is_active: true,
                    updated_at: '2026-09-29T10:00:00Z',
                    profile: { name: 'Serene Summer', type: 'sail', draft: 7.87, draftConfirmedFt: 7.87 },
                },
            ],
            'owner-1',
        );
        expect(fleet.vessels[0].profile.draftConfirmedFt).toBe(7.87);
        expect(isDraftConfirmed(fleet.vessels[0].profile)).toBe(true);
    });
});

describe('the Vessel tab’s starting figures, shared (review 2026-09-29)', () => {
    it('are the figures the Vessel tab has always started a boat with', () => {
        expect(VESSEL_SETTINGS_SEED).toEqual({
            name: 'My Boat',
            type: 'sail',
            length: 30,
            beam: 10,
            draft: 5,
            displacement: 10000,
            maxWaveHeight: 6,
            cruisingSpeed: 6,
            fuelCapacity: 0,
            waterCapacity: 0,
        });
        expect(Object.isFrozen(VESSEL_SETTINGS_SEED)).toBe(true);
    });

    it('fill in under the saved profile and the edit, as the Vessel tab always has', () => {
        expect(vesselWithSettingsDefaults(undefined, { length: 40 })).toEqual({ ...VESSEL_SETTINGS_SEED, length: 40 });
        const boat: VesselProfile = { ...defaultVesselProfile('Serene Summer'), length: 44, draft: 7.87 };
        expect(vesselWithSettingsDefaults(boat, { beam: 13 })).toEqual({ ...boat, beam: 13 });
        expect(vesselWithSettingsDefaults(null)).toEqual(VESSEL_SETTINGS_SEED);
    });

    it('the Vessel tab builds its signed-out profile from the shared figures, not its own copy', () => {
        const source = readFileSync('components/settings/VesselTab.tsx', 'utf8');
        expect(source).toMatch(/vesselWithSettingsDefaults\(/);
        expect(source).not.toMatch(/\blength:\s*30,/);
        expect(source).not.toMatch(/\bdisplacement:\s*10000,/);
    });
});

describe('draftSaveProfilePatch — never a boat of zeros from the draft modal (review 2026-09-29)', () => {
    const GUESSED = ['beam', 'cruisingSpeed', 'displacement', 'length', 'maxWaveHeight'];
    const saveOf = (vessel: VesselProfile | undefined) => draftSaveProfilePatch(vessel, confirmDraftPatch(vessel, 1.8));

    it('no vessel profile: the whole Vessel-tab boat, the guesses marked estimated, the draft the skipper’s own', () => {
        const saved = saveOf(undefined);
        expect(saved).toMatchObject({
            name: 'My Boat',
            type: 'sail',
            length: 30,
            beam: 10,
            displacement: 10000,
            maxWaveHeight: 6,
            cruisingSpeed: 6,
            fuelCapacity: 0,
            waterCapacity: 0,
        });
        // The seed's own placeholder draft (5 ft) never survives.
        expect(saved.draft).toBeCloseTo(1.8 * FEET_PER_METRE, 10);
        expect(saved.draftConfirmedFt).toBe(saved.draft);
        expect([...(saved.estimatedFields ?? [])].sort()).toEqual(GUESSED);
        expect(isDraftConfirmed(saved)).toBe(true);
        expect(vesselMaxWaveHeightMetres(saved)).toBeGreaterThan(0);
    });

    it('a profile with no figures in it (released placeholder, fresh New Vessel) gets the same, keeping its name and hull type', () => {
        const placeholder = defaultVesselProfile('My Boat');
        expect({ ...placeholder, ...saveOf(placeholder) }).toMatchObject({
            name: 'My Boat',
            length: 30,
            cruisingSpeed: 6,
            maxWaveHeight: 6,
        });
        const fresh: VesselProfile = {
            ...defaultVesselProfile(),
            type: 'power',
            crewCount: 3,
            estimatedFields: ['draft'],
        };
        const saved = saveOf(fresh);
        // A patch: it leaves her name, hull type and crew alone.
        expect(saved).not.toHaveProperty('name');
        expect(saved).not.toHaveProperty('type');
        expect({ ...fresh, ...saved }).toMatchObject({
            name: 'New Vessel',
            type: 'power',
            crewCount: 3,
            length: 30,
            cruisingSpeed: 6,
        });
        // The draft is confirmed, so it is no longer an estimate.
        expect([...(saved.estimatedFields ?? [])].sort()).toEqual(GUESSED);
        expect(isDraftConfirmed({ ...fresh, ...saved })).toBe(true);
        // A blank profile with no name gets the Vessel tab's.
        expect(saveOf({ ...placeholder, name: '  ' }).name).toBe('My Boat');
    });

    it('a real boat — any figure of her own — gets the draft patch and nothing else', () => {
        const boat: VesselProfile = { ...defaultVesselProfile('Serene Summer'), length: 44 };
        const patch = confirmDraftPatch(boat, 1.8);
        expect(draftSaveProfilePatch(boat, patch)).toBe(patch);
        const slowBoat: VesselProfile = { ...defaultVesselProfile('Drifter'), cruisingSpeed: 4 };
        expect(draftSaveProfilePatch(slowBoat, confirmDraftPatch(slowBoat, 1.8))).toEqual(
            confirmDraftPatch(slowBoat, 1.8),
        );
    });

    it('a crew member’s profile is not a boat to guess at', () => {
        const crew: VesselProfile = { ...defaultVesselProfile('Crew Member'), type: 'observer' };
        const patch = confirmDraftPatch(crew, 1.8);
        expect(draftSaveProfilePatch(crew, patch)).toBe(patch);
    });
});
