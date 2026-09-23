import { describe, expect, it } from 'vitest';
import { snapshotAutoroutingVesselProfile } from '../services/autoroutingVesselProfile';
import { FEET_PER_METRE } from '../services/units';
import {
    autoroutingVesselWarnings,
    validateAutoroutingVesselProfile,
    AUTOROUTING_VESSEL_LIMITS_M,
} from '../supabase/functions/_shared/autorouting-vessel';

const stored = () => ({
    length: 12.4 * FEET_PER_METRE,
    beam: 4.3 * FEET_PER_METRE,
    airDraft: 18.2 * FEET_PER_METRE,
    draft: 2.4 * FEET_PER_METRE,
});

describe('autorouting vessel profile snapshot', () => {
    it('converts stored feet exactly once, retains precision, and detaches estimates', () => {
        const vessel = { ...stored(), estimatedFields: ['beam', 'draft'] };
        const profile = snapshotAutoroutingVesselProfile(vessel);
        vessel.beam = 0;
        vessel.estimatedFields.length = 0;
        expect(profile).toEqual({
            length: { status: 'measured', valueM: 12.4 },
            beam: { status: 'estimated', valueM: 4.3 },
            airDraft: { status: 'measured', valueM: 18.2 },
            draftStatus: 'estimated',
        });
        expect(validateAutoroutingVesselProfile(profile)).toEqual(profile);
    });

    it.each([undefined, null, {}, { length: 0, beam: -1, airDraft: NaN, draft: Infinity }])(
        'keeps unset/corrupt values explicitly missing without defaults: %j',
        (vessel) => {
            expect(snapshotAutoroutingVesselProfile(vessel)).toEqual({
                length: { status: 'missing' },
                beam: { status: 'missing' },
                airDraft: { status: 'missing' },
                draftStatus: 'missing',
            });
        },
    );

    it('retains estimated air draft and treats out-of-trial dimensions as unavailable', () => {
        expect(snapshotAutoroutingVesselProfile({ ...stored(), estimatedFields: ['airDraft'] }).airDraft.status).toBe(
            'estimated',
        );
        expect(snapshotAutoroutingVesselProfile({ length: 301 * FEET_PER_METRE }).length).toEqual({
            status: 'missing',
        });
    });

    it.each([
        null,
        {},
        { status: 'missing', valueM: 0 },
        { status: 'measured' },
        { status: 'measured', valueM: 0 },
        { status: 'measured', valueM: -1 },
        { status: 'measured', valueM: Infinity },
        { status: 'measured', valueM: NaN },
        { status: 'measured', valueM: '12' },
        { status: 'unknown', valueM: 12 },
        { status: 'measured', valueM: 12, unit: 'ft' },
        { status: 'measured', valueM: 301 },
    ])('rejects malformed/oversize dimension values: %j', (length) => {
        expect(() =>
            validateAutoroutingVesselProfile({ ...snapshotAutoroutingVesselProfile(stored()), length }),
        ).toThrow();
    });

    it('rejects excess/missing fields, invalid provenance and each dimension-specific limit', () => {
        const profile = snapshotAutoroutingVesselProfile(stored());
        for (const bad of [
            null,
            {},
            { ...profile, extra: true },
            { ...profile, draftStatus: 'confirmed' },
            { ...profile, draftStatus: { toString: () => 'measured' } },
        ]) {
            expect(() => validateAutoroutingVesselProfile(bad)).toThrow();
        }
        for (const key of ['length', 'beam', 'airDraft'] as const) {
            expect(() =>
                validateAutoroutingVesselProfile({
                    ...profile,
                    [key]: { status: 'measured', valueM: AUTOROUTING_VESSEL_LIMITS_M[key] + 0.01 },
                }),
            ).toThrow();
        }
    });

    it('preserves honest missing/estimated warnings without claiming overhead clearance', () => {
        const profile = snapshotAutoroutingVesselProfile({
            ...stored(),
            beam: 0,
            estimatedFields: ['draft', 'airDraft'],
        });
        const warnings = autoroutingVesselWarnings(profile).join(' ');
        expect(warnings).toMatch(/draft is estimated/);
        expect(warnings).toMatch(/Beam is missing/);
        expect(warnings).toMatch(/Air draft is estimated/);
        expect(warnings).toMatch(/does not establish bridge or overhead clearance/);
        expect(autoroutingVesselWarnings().join(' ')).toMatch(/measurement status is unknown/);
    });
});
