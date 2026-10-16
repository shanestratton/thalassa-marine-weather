import { describe, expect, it } from 'vitest';
import { EMPTY_SAIL_INVENTORY, parseSailInventory, recommendSailPlan } from '../services/sailing/sailInventory';
import { sailInventoryFixture, sailWindFixture } from './helpers/sailInventoryFixture';

const advice = (wind: number, previous?: ReturnType<typeof recommendSailPlan>, offset = 0) =>
    recommendSailPlan({
        inventory: sailInventoryFixture(),
        vesselType: 'sail',
        scopeKey: 'account-a:boat-a',
        sample: sailWindFixture(wind, offset),
        previous,
    });
describe('generic selected-vessel sail inventory', () => {
    it('starts empty and has no yacht or rig-specific sail choices', () => {
        expect(EMPTY_SAIL_INVENTORY.sails).toEqual([]);
        expect(EMPTY_SAIL_INVENTORY.plans).toEqual([]);
        expect(
            recommendSailPlan({
                inventory: EMPTY_SAIL_INVENTORY,
                vesselType: 'sail',
                scopeKey: 'a:b',
                sample: sailWindFixture(),
            }),
        ).toBeNull();
    });
    it('uses only this inventory, for a one-sail boat as well as a multi-sail rig', () => {
        const one = sailInventoryFixture();
        one.sails = [one.sails[0]];
        one.plans = [one.plans[1]];
        expect(
            recommendSailPlan({
                inventory: one,
                vesselType: 'sail',
                scopeKey: 'other:boat',
                sample: sailWindFixture(20),
            })?.text,
        ).toBe('Reduced plan: Fixture main reef 1');
        expect(advice(12)?.text).toBe('Light plan: Fixture main full + Fixture jib full');
    });
    it('keeps a known zero wind valid when the user defined a matching plan', () => {
        expect(advice(0)?.planId).toBe('light');
    });
    it('refuses missing wind, unknown source, invalid clocks and non-sailing profiles', () => {
        for (const vesselType of ['power', 'observer', undefined])
            expect(
                recommendSailPlan({
                    inventory: sailInventoryFixture(),
                    vesselType,
                    scopeKey: 'a:b',
                    sample: sailWindFixture(),
                }),
            ).toBeNull();
        for (const sample of [
            null,
            { ...sailWindFixture(), twsKn: NaN },
            { ...sailWindFixture(), sourceKey: '' },
            { ...sailWindFixture(), timeMs: NaN },
        ])
            expect(
                recommendSailPlan({ inventory: sailInventoryFixture(), vesselType: 'sail', scopeKey: 'a:b', sample }),
            ).toBeNull();
    });
    it('does not fill a crossover gap, angle gap or the end of the user wind limit', () => {
        expect(advice(36)).toBeNull();
        expect(
            recommendSailPlan({
                inventory: sailInventoryFixture(),
                vesselType: 'sail',
                scopeKey: 'a:b',
                sample: { ...sailWindFixture(), twaDeg: 20 },
            }),
        ).toBeNull();
    });
    it('takes stronger wind immediately and keeps reduced sail through small oscillations', () => {
        const first = advice(14)!;
        const reef = advice(16, first, 1000)!;
        expect(reef.planId).toBe('reef');
        const drop = advice(14, reef, 2000)!;
        expect(drop.planId).toBe('reef');
        expect(drop.held).toBe(true);
        const smallRise = advice(14.5, drop, 3000)!;
        expect(smallRise.planId).toBe('reef');
        expect(advice(12.9, smallRise, 4000)?.planId).toBe('light');
        expect(advice(40, reef, 5000)).toBeNull();
    });
    it('uses known gusts conservatively and adds only the user-entered reef points', () => {
        const result = recommendSailPlan({
            inventory: sailInventoryFixture(),
            vesselType: 'sail',
            scopeKey: 'a:b',
            sample: { ...sailWindFixture(10), gustKn: 28 },
        });
        expect(result?.planId).toBe('reef');
        expect(result?.text).toContain('reef 2');
        expect(result?.windKn).toBe(28);
        expect(advice(26)?.sails).toEqual([{ sailId: 'main', reef: 2 }]);
    });
    it('applies reef-point hysteresis even within the same crossover plan', () => {
        const reef = advice(26)!;
        expect(advice(24, reef, 1000)?.sails[0].reef).toBe(2);
        expect(advice(22.9, reef, 2000)?.sails[0].reef).toBe(1);
    });
    it('does not carry history across accounts, vessels, inventory edits or forecast sources', () => {
        const previous = advice(16)!;
        const base = {
            inventory: sailInventoryFixture(),
            vesselType: 'sail',
            scopeKey: 'account-a:boat-a',
            sample: sailWindFixture(14, 1000),
            previous,
        };
        expect(recommendSailPlan({ ...base, scopeKey: 'account-b:boat-a' })?.planId).toBe('light');
        expect(recommendSailPlan({ ...base, scopeKey: 'account-a:boat-b' })?.planId).toBe('light');
        expect(recommendSailPlan({ ...base, sample: { ...base.sample, sourceKey: 'new-run' } })?.planId).toBe('light');
        const changed = sailInventoryFixture();
        changed.hysteresisKn = 1;
        expect(recommendSailPlan({ ...base, inventory: changed })?.planId).toBe('light');
        expect(recommendSailPlan({ ...base, sample: sailWindFixture(14, -1000) })?.planId).toBe('light');
    });
    it('rejects broken references, duplicate IDs and invalid reef stages as a whole', () => {
        const badReference = sailInventoryFixture();
        badReference.plans[0].sails[0].sailId = 'absent';
        const duplicate = sailInventoryFixture();
        duplicate.sails.push(duplicate.sails[0]);
        const badReef = sailInventoryFixture();
        badReef.plans[0].sails[0].reef = 3;
        const badOrder = sailInventoryFixture();
        badOrder.sails[0].reefPointsKn = [25, 15];
        for (const value of [badReference, duplicate, badReef, badOrder]) expect(parseSailInventory(value)).toBeNull();
    });
    it('bounds profile counts, names and wind ranges without truncating the user data', () => {
        const tooMany = sailInventoryFixture();
        tooMany.sails = Array.from({ length: 25 }, (_, i) => ({ ...tooMany.sails[0], id: `s${i}` }));
        expect(parseSailInventory(tooMany)).toBeNull();
        const bad = sailInventoryFixture();
        bad.sails[0].name = 'x'.repeat(61);
        expect(parseSailInventory(bad)).toBeNull();
        const range = sailInventoryFixture();
        range.plans[0].maxTwsKn = range.plans[0].minTwsKn;
        expect(parseSailInventory(range)).toBeNull();
    });
});
