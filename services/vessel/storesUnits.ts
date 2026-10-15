/**
 * Ship's Stores in units (131-B14): 1 kg of sugar, not a bare '1000'.
 *
 * A row keeps the unit it was written in: the Grocery List writes g, ml or
 * whole (PurchaseUnits), the Add form the unit picked. On screen and on the
 * PDF a weight or a volume reads in the skipper's unit system, at the size a
 * person says it: 750 g, 1.5 kg, 12 oz, 2.2 lb; 330 ml, 1.5 L, 12 fl oz,
 * 1.3 gal. A count is the number alone. The conversions are PurchaseUnits'
 * own, so Stores and the Galley agree on what a pound is.
 *
 * − and + step a sensible amount of what is there: 100 g or 100 ml (10 under
 * 100), an ounce (a quarter pound from a pound up), 4 fl oz (a quarter gallon
 * from a gallon up); one of a count. A − never takes more than is there.
 */
import { convertQuantity } from '../PurchaseUnits';
import type { UnitPreferences } from '../../types';

export type StoresUnitSystem = 'metric' | 'imperial';

/**
 * The skipper's unit system for Stores, from Settings' liquid volume: US
 * gallons there is US customary here (lb, oz, fl oz, gal), litres metric.
 */
export function storesUnitSystem(volume: UnitPreferences['volume'] | null | undefined): StoresUnitSystem {
    return volume === 'gal' ? 'imperial' : 'metric';
}

const normal = (unit: string | null | undefined) => (unit ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/** Units that are a plain count: the number alone says it. */
const COUNT_WORDS = new Set([
    '',
    'whole',
    'each',
    'ea',
    'item',
    'items',
    'unit',
    'units',
    'piece',
    'pieces',
    'pc',
    'pcs',
    'count',
]);

export const isCountUnit = (unit: string | null | undefined): boolean => COUNT_WORDS.has(normal(unit));

/** Short spellings PurchaseUnits doesn't know, for reading a row only. */
const SPELLINGS: Record<string, string> = { gal: 'gallon', gals: 'gallons', qt: 'quart', pt: 'pint', floz: 'fl oz' };

/** A weight or a volume: how many grams or millilitres one of `unit` is. */
function measureOf(unit: string | null | undefined): { kind: 'mass' | 'volume'; base: number } | null {
    const spelled = SPELLINGS[normal(unit)] ?? (unit ?? '').trim();
    if (!spelled) return null;
    const grams = convertQuantity(1, spelled, 'g');
    if (grams !== null && grams > 0) return { kind: 'mass', base: grams };
    const millilitres = convertQuantity(1, spelled, 'ml');
    if (millilitres !== null && millilitres > 0) return { kind: 'volume', base: millilitres };
    return null;
}

/** A number as the phone writes numbers: '2.5' or '2,5', never '2.5000000001'. */
const num = (value: number, digits: number) => value.toLocaleString(undefined, { maximumFractionDigits: digits });

/** Grams (or millilitres) at metric size: 750 g, 1.5 kg. */
function metricText(base: number, small: string, large: string): string {
    // Sized as it will print: 999.96 g is '1 kg', not '1,000 g'.
    const rounded = Math.round(base * 10) / 10;
    if (rounded >= 1000) return `${num(base / 1000, 2)} ${large}`;
    return `${num(rounded, rounded >= 10 ? 0 : 1)} ${small}`;
}

/** Ounces (or fluid ounces) at US size: 12 oz, 2.2 lb; 12 fl oz, 1.3 gal. */
function imperialText(ounces: number, perLarge: number, small: string, large: string): string {
    const rounded = Math.round(ounces * 10) / 10;
    if (rounded >= perLarge) return `${num(ounces / perLarge, 2)} ${large}`;
    return `${num(rounded, 1)} ${small}`;
}

const OUNCE_G = convertQuantity(1, 'oz', 'g') ?? 28.35;
const FLUID_OUNCE_ML = convertQuantity(1, 'fl oz', 'ml') ?? 29.57;

/** What a row holds, as the skipper reads it: '1 kg', '750 ml', '12', '3 tins'. */
export function storesAmount(quantity: number, unit: string | null | undefined, system: StoresUnitSystem): string {
    const amount = Number.isFinite(quantity) ? Math.max(0, quantity) : 0;
    const measure = measureOf(unit);
    if (measure?.kind === 'mass') {
        const grams = amount * measure.base;
        return system === 'imperial' ? imperialText(grams / OUNCE_G, 16, 'oz', 'lb') : metricText(grams, 'g', 'kg');
    }
    if (measure?.kind === 'volume') {
        const millilitres = amount * measure.base;
        return system === 'imperial'
            ? imperialText(millilitres / FLUID_OUNCE_ML, 128, 'fl oz', 'gal')
            : metricText(millilitres, 'ml', 'L');
    }
    const count = num(amount, 2);
    if (isCountUnit(unit)) return count;
    const word = (unit ?? '').trim();
    // An old package label ('6 pack'): two of them, not 'two 6 pack'.
    return /^\d/.test(word) ? `${count} × ${word}` : `${count} ${word}`;
}

export interface StoresStep {
    /** How much one − or + changes, in the row's own unit. */
    size: number;
    /** That amount in words, in the skipper's units ('100 g'); null for a count. */
    label: string | null;
}

/** The step − and + make on a row holding `quantity` of `unit`. */
export function storesStep(quantity: number, unit: string | null | undefined, system: StoresUnitSystem): StoresStep {
    const measure = measureOf(unit);
    if (!measure) return { size: 1, label: null };
    const base = (Number.isFinite(quantity) ? Math.max(0, quantity) : 0) * measure.base;
    let stepBase: number;
    let label: string;
    if (system === 'imperial' && measure.kind === 'mass') {
        const quarterPound = base >= 16 * OUNCE_G;
        stepBase = (quarterPound ? 4 : 1) * OUNCE_G;
        label = quarterPound ? `${num(0.25, 2)} lb` : '1 oz';
    } else if (system === 'imperial') {
        const quarterGallon = base >= 128 * FLUID_OUNCE_ML;
        stepBase = (quarterGallon ? 32 : 4) * FLUID_OUNCE_ML;
        label = quarterGallon ? `${num(0.25, 2)} gal` : '4 fl oz';
    } else {
        stepBase = base < 100 ? 10 : 100;
        label = `${stepBase} ${measure.kind === 'mass' ? 'g' : 'ml'}`;
    }
    return { size: Math.round((stepBase / measure.base) * 1e6) / 1e6, label };
}

/** Anything left to take: a float's dust after a few steps is nothing. */
export const hasStock = (quantity: number): boolean => Number.isFinite(quantity) && quantity > 1e-9;

/**
 * The delta one − (-1) or + (1) sends, on the delta path: a − never takes more
 * than is there, so a last 35 g is "took 35 g", not "took 100 g".
 */
export function storesStepDelta(
    quantity: number,
    unit: string | null | undefined,
    direction: 1 | -1,
    system: StoresUnitSystem,
): number {
    const { size } = storesStep(quantity, unit, system);
    if (direction > 0) return size;
    return hasStock(quantity) ? -Math.min(size, quantity) : 0;
}

export interface UnitChoice {
    /** What the row stores. */
    value: string;
    label: string;
}

/** The units the Add and Edit forms offer: names PurchaseUnits converts, so the Galley can use the row. */
const CHOICES: Record<StoresUnitSystem, UnitChoice[]> = {
    metric: [
        { value: 'whole', label: 'Count' },
        { value: 'g', label: 'g' },
        { value: 'kg', label: 'kg' },
        { value: 'ml', label: 'ml' },
        { value: 'L', label: 'L' },
    ],
    imperial: [
        { value: 'whole', label: 'Count' },
        { value: 'oz', label: 'oz' },
        { value: 'lb', label: 'lb' },
        { value: 'fl oz', label: 'fl oz' },
        { value: 'gallon', label: 'gal' },
    ],
};

/**
 * The unit picker's choices. A row's own unit stays as it is written ('each'
 * is Count; 'l' is L; one from the other system or one typed long ago is
 * added), so opening and saving a row never rewrites its unit.
 */
export function unitChoices(system: StoresUnitSystem, current?: string | null): UnitChoice[] {
    const own = (current ?? '').trim();
    const choices = CHOICES[system];
    if (current === undefined || current === null) return choices;
    if (isCountUnit(own))
        return choices.map((choice) => (choice.value === 'whole' ? { ...choice, value: own } : choice));
    if (choices.some((choice) => normal(choice.value) === normal(own))) {
        return choices.map((choice) => (normal(choice.value) === normal(own) ? { ...choice, value: own } : choice));
    }
    return [...choices, { value: own, label: own }];
}

/** A number typed into a Stores form: decimals allowed, never below nothing; null when it isn't a number. */
export function typedAmount(typed: string): number | null {
    const text = typed.trim().replace(',', '.');
    if (!text) return null;
    const value = Number(text);
    return Number.isFinite(value) ? Math.max(0, Math.round(value * 1000) / 1000) : null;
}

/**
 * A typed amount carried to another unit of the same kind (1000 in g is 1 in
 * kg). Across kinds (a count picked as kg) the number stays: that is a unit
 * set right, not a conversion.
 */
export function retypedAmount(typed: string, from: string, to: string): string {
    const value = typedAmount(typed);
    if (value === null || isCountUnit(from) || isCountUnit(to)) return typed;
    const converted = convertQuantity(value, SPELLINGS[normal(from)] ?? from, SPELLINGS[normal(to)] ?? to);
    return converted === null ? typed : String(Math.round(converted * 1000) / 1000);
}
