/**
 * Ship's Stores speaks units (131-B14; binder audit STORES-06, STORES-05,
 * STORES-12).
 *
 * A Grocery List buy of sugar is stored as 1000 g, and Stores showed a bare
 * '1000'; ± stepped one gram; the header added grams, millilitres and tins
 * into 'units'. Now amounts read the way a person says them, in the skipper's
 * unit system, and − / + step a sensible amount. Fictional stores.
 */
import { describe, expect, it } from 'vitest';
import {
    fieldAmount,
    hasStock,
    isCountUnit,
    retypedAmount,
    retypedMinimum,
    storesAmount,
    storesStep,
    storesStepDelta,
    storesUnitSystem,
    typedAmount,
    typedMinimum,
    unitChoices,
} from '../services/vessel/storesUnits';
import { convertQuantity } from '../services/PurchaseUnits';

/** A number as the phone writes it, for locale-proof expectations. */
const n = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 2 });

describe('the unit system follows Settings', () => {
    it('US gallons is US units; litres, or nothing set, is metric', () => {
        expect(storesUnitSystem('gal')).toBe('imperial');
        expect(storesUnitSystem('l')).toBe('metric');
        expect(storesUnitSystem(undefined)).toBe('metric');
    });
});

describe('amounts in units', () => {
    it('1000 g of sugar is 1 kg, 750 g is 750 g, 2.5 kg stays 2.5 kg', () => {
        expect(storesAmount(1000, 'g', 'metric')).toBe('1 kg');
        expect(storesAmount(750, 'g', 'metric')).toBe('750 g');
        expect(storesAmount(2.5, 'kg', 'metric')).toBe(`${n(2.5)} kg`);
        expect(storesAmount(0.75, 'kg', 'metric')).toBe('750 g');
        // Sized as it prints: never '1,000 g'.
        expect(storesAmount(999.96, 'g', 'metric')).toBe('1 kg');
    });

    it('volumes: 1500 ml is 1.5 L, 330 ml is 330 ml, a litre written "l" or "litres" reads the same', () => {
        expect(storesAmount(1500, 'ml', 'metric')).toBe(`${n(1.5)} L`);
        expect(storesAmount(330, 'ml', 'metric')).toBe('330 ml');
        expect(storesAmount(2, 'l', 'metric')).toBe('2 L');
        expect(storesAmount(2, 'litres', 'metric')).toBe('2 L');
    });

    it('in US units: 1000 g is 2.2 lb, 200 g is 7.1 oz, 1 L is 33.8 fl oz, a gallon is 1 gal', () => {
        expect(storesAmount(1000, 'g', 'imperial')).toBe(`${n(2.2)} lb`);
        expect(storesAmount(200, 'g', 'imperial')).toBe(`${(7.1).toLocaleString()} oz`);
        expect(storesAmount(1000, 'ml', 'imperial')).toBe(`${(33.8).toLocaleString()} fl oz`);
        expect(storesAmount(1, 'gallon', 'imperial')).toBe('1 gal');
        expect(storesAmount(1, 'gal', 'imperial')).toBe('1 gal');
    });

    it('a row stored in pounds reads in kilograms for a metric skipper', () => {
        expect(storesAmount(5, 'lb', 'metric')).toBe(`${n(2.27)} kg`);
    });

    it('a count is the number alone; any other word is kept; an old package label is "2 × 6 pack"', () => {
        expect(storesAmount(12, 'whole', 'metric')).toBe('12');
        expect(storesAmount(3, 'each', 'imperial')).toBe('3');
        expect(storesAmount(2.5, 'whole', 'metric')).toBe(n(2.5));
        expect(storesAmount(4, 'rolls', 'metric')).toBe('4 rolls');
        expect(storesAmount(2, '6 pack', 'metric')).toBe('2 × 6 pack');
        expect(storesAmount(5, '', 'metric')).toBe('5');
        expect(storesAmount(5, null, 'metric')).toBe('5');
    });

    it('never prints below nothing, or float noise', () => {
        expect(storesAmount(-3, 'whole', 'metric')).toBe('0');
        expect(storesAmount(0.30000000000000004, 'kg', 'metric')).toBe('300 g');
        expect(storesAmount(Number.NaN, 'g', 'metric')).toBe('0 g');
    });

    it('a legacy package unit ("1kg bag") reads as its weight', () => {
        expect(storesAmount(2, '1kg bag', 'metric')).toBe('2 kg');
    });

    it('knows a count when it sees one', () => {
        for (const unit of ['whole', 'each', 'EA', ' units ', '', 'pcs']) expect(isCountUnit(unit)).toBe(true);
        for (const unit of ['g', 'kg', 'rolls', 'L']) expect(isCountUnit(unit)).toBe(false);
    });
});

describe('± steps a sensible amount', () => {
    it('metric: 100 g or 100 ml, 10 under 100; kilograms step 0.1 kg; a count steps one', () => {
        expect(storesStep(1000, 'g', 'metric')).toEqual({ size: 100, label: '100 g' });
        expect(storesStep(35, 'g', 'metric')).toEqual({ size: 10, label: '10 g' });
        expect(storesStep(750, 'ml', 'metric')).toEqual({ size: 100, label: '100 ml' });
        expect(storesStep(2.5, 'kg', 'metric')).toEqual({ size: 0.1, label: '100 g' });
        expect(storesStep(2, 'L', 'metric')).toEqual({ size: 0.1, label: '100 ml' });
        expect(storesStep(12, 'whole', 'metric')).toEqual({ size: 1, label: null });
        expect(storesStep(4, 'rolls', 'metric')).toEqual({ size: 1, label: null });
    });

    it('US: an ounce under a pound, a quarter pound from a pound; 4 fl oz under a gallon, a quarter gallon above', () => {
        const ounce = convertQuantity(1, 'oz', 'g')!;
        const fluidOunce = convertQuantity(1, 'fl oz', 'ml')!;
        const step = (quantity: number, unit: string) => storesStep(quantity, unit, 'imperial');
        expect(step(200, 'g').label).toBe('1 oz');
        expect(step(200, 'g').size).toBeCloseTo(ounce, 4);
        expect(step(1000, 'g').label).toBe(`${n(0.25)} lb`);
        expect(step(1000, 'g').size).toBeCloseTo(4 * ounce, 4);
        expect(step(1000, 'ml').label).toBe('4 fl oz');
        expect(step(1000, 'ml').size).toBeCloseTo(4 * fluidOunce, 4);
        expect(step(2, 'gallon').label).toBe(`${n(0.25)} gal`);
        expect(step(2, 'gallon').size).toBeCloseTo(0.25, 2);
    });

    it('a − never takes more than is there, and nothing from nothing', () => {
        expect(storesStepDelta(1000, 'g', -1, 'metric')).toBe(-100);
        expect(storesStepDelta(1000, 'g', 1, 'metric')).toBe(100);
        expect(storesStepDelta(5, 'g', -1, 'metric')).toBe(-5);
        expect(storesStepDelta(0.5, 'whole', -1, 'metric')).toBe(-0.5);
        expect(storesStepDelta(0, 'whole', -1, 'metric')).toBe(0);
        expect(storesStepDelta(0, 'whole', 1, 'metric')).toBe(1);
        expect(hasStock(5.551115123125783e-17)).toBe(false);
        expect(hasStock(0.001)).toBe(true);
    });
});

describe('the unit picker', () => {
    it('offers Count and the metric or US units, as names the Galley converts', () => {
        expect(unitChoices('metric').map((choice) => choice.label)).toEqual(['Count', 'g', 'kg', 'ml', 'L']);
        expect(unitChoices('imperial').map((choice) => choice.label)).toEqual(['Count', 'oz', 'lb', 'fl oz', 'gal']);
        for (const choice of [...unitChoices('metric'), ...unitChoices('imperial')]) {
            if (choice.label === 'Count') continue;
            const grams = convertQuantity(1, choice.value, 'g');
            const millilitres = convertQuantity(1, choice.value, 'ml');
            expect(grams ?? millilitres, choice.value).not.toBeNull();
        }
    });

    it("keeps a row's own unit as written, so opening and saving never rewrites it", () => {
        expect(unitChoices('metric', 'each').find((choice) => choice.label === 'Count')?.value).toBe('each');
        expect(unitChoices('metric', 'l').find((choice) => choice.label === 'L')?.value).toBe('l');
        expect(unitChoices('metric', 'lb').map((choice) => choice.value)).toContain('lb');
        expect(unitChoices('imperial', 'rolls').at(-1)).toEqual({ value: 'rolls', label: 'rolls' });
    });
});

describe('typed amounts', () => {
    it('take decimals with a point or a comma, never below nothing, and nothing for a blank', () => {
        expect(typedAmount('2.5')).toBe(2.5);
        expect(typedAmount('2,5')).toBe(2.5);
        expect(typedAmount('-5')).toBe(0);
        expect(typedAmount('')).toBeNull();
        expect(typedAmount('lots')).toBeNull();
    });

    it('carry to another unit of the same kind; a count set to kg keeps its number', () => {
        expect(retypedAmount('1500', 'g', 'kg')).toBe('1.5');
        expect(retypedAmount('2', 'L', 'ml')).toBe('2000');
        expect(retypedAmount('3', 'whole', 'kg')).toBe('3');
        expect(retypedAmount('500', 'g', 'ml')).toBe('500');
        expect(retypedAmount('', 'g', 'kg')).toBe('');
    });

    it('fill a form field without float dust: 1.7, not 1.7000000000000002', () => {
        // What a few ± steps of 0.1 kg, 1 oz or 100 ml leave on a row.
        expect(fieldAmount(1.5 + 0.1 + 0.1)).toBe('1.7');
        expect(fieldAmount(28.35 + 28.35 + 28.35)).toBe('85.05');
        expect(fieldAmount(0.3 - 0.1)).toBe('0.2');
        expect(fieldAmount(1000)).toBe('1000');
        expect(fieldAmount(2.5)).toBe('2.5');
        expect(fieldAmount(Number.NaN)).toBe('');
        // And reads back as the same number, so Save sends no change.
        expect(typedAmount(fieldAmount(1.5 + 0.1 + 0.1))).toBe(1.7);
    });
});

describe('a minimum is whole, as the server keeps it', () => {
    // inventory_items.min_quantity is an integer column: a 0.5 would fail its
    // push and hold up every later change to the row.
    it('a typed minimum rounds up to a whole number, so the alert comes no later than asked', () => {
        expect(typedMinimum('2')).toBe(2);
        expect(typedMinimum('0.5')).toBe(1);
        expect(typedMinimum('1,2')).toBe(2);
        expect(typedMinimum('2.0000001')).toBe(2);
        expect(typedMinimum('-3')).toBe(0);
        expect(typedMinimum('')).toBeNull();
        expect(typedMinimum('lots')).toBeNull();
    });

    it('a minimum carried to another unit stays whole: 500 g is 1 kg, 1 kg is 1000 g', () => {
        expect(retypedMinimum('500', 'g', 'kg')).toBe('1');
        expect(retypedMinimum('1500', 'g', 'kg')).toBe('2');
        expect(retypedMinimum('1', 'kg', 'g')).toBe('1000');
        expect(retypedMinimum('8', 'oz', 'lb')).toBe('1');
        expect(retypedMinimum('1', 'L', 'ml')).toBe('1000');
        expect(retypedMinimum('3', 'whole', 'kg')).toBe('3');
        expect(retypedMinimum('', 'g', 'kg')).toBe('');
        for (const [typed, from, to] of [
            ['750', 'ml', 'L'],
            ['5', 'oz', 'lb'],
            ['3', 'lb', 'kg'],
            ['250', 'g', 'oz'],
        ]) {
            expect(Number.isInteger(Number(retypedMinimum(typed, from, to))), `${typed} ${from} to ${to}`).toBe(true);
        }
    });
});
