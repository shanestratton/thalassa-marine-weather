/**
 * GlobalUnitService — Multi-currency and metric/imperial conversions.
 *
 * Handles:
 *  - Currency conversions (AUD, USD, EUR, NZD, FJD, XPF)
 *  - Weight: kg ↔ lb ↔ oz
 *  - Volume: L ↔ gal (US) ↔ qt ↔ fl oz
 *  - Length: m ↔ ft ↔ nm
 *  - Temperature: °C ↔ °F
 *
 * Stores user preference in localStorage for offline access.
 */

// ── Types ──────────────────────────────────────────────────────────────────

export type CurrencyCode = 'AUD' | 'USD' | 'EUR' | 'NZD' | 'FJD' | 'XPF' | 'GBP';
export type UnitSystem = 'metric' | 'imperial';

export interface UnitPreferences {
    currency: CurrencyCode;
    unitSystem: UnitSystem;
}

// ── Currency Rates (offline defaults — updated when online) ────────────────
// Rates relative to 1 AUD (base currency for Pacific cruising)

const DEFAULT_RATES: Record<CurrencyCode, number> = {
    AUD: 1.0,
    USD: 0.65,
    EUR: 0.6,
    NZD: 1.08,
    FJD: 1.45,
    XPF: 71.5, // CFP franc (New Caledonia)
    GBP: 0.52,
};

const RATES_KEY = 'thalassa_currency_rates';
const RATES_UPDATED_KEY = 'thalassa_rates_updated';
const PREFS_KEY = 'thalassa_unit_prefs';

// ── Currency Symbols ──────────────────────────────────────────────────────

const CURRENCY_SYMBOLS: Record<CurrencyCode, string> = {
    AUD: 'A$',
    USD: 'US$',
    EUR: '€',
    NZD: 'NZ$',
    FJD: 'FJ$',
    XPF: '₣',
    GBP: '£',
};

export function getCurrencySymbol(code: CurrencyCode): string {
    return CURRENCY_SYMBOLS[code] || code;
}

export function getAvailableCurrencies(): { code: CurrencyCode; symbol: string; name: string }[] {
    return [
        { code: 'AUD', symbol: 'A$', name: 'Australian Dollar' },
        { code: 'USD', symbol: 'US$', name: 'US Dollar' },
        { code: 'EUR', symbol: '€', name: 'Euro' },
        { code: 'NZD', symbol: 'NZ$', name: 'New Zealand Dollar' },
        { code: 'FJD', symbol: 'FJ$', name: 'Fijian Dollar' },
        { code: 'XPF', symbol: '₣', name: 'CFP Franc (New Caledonia)' },
        { code: 'GBP', symbol: '£', name: 'British Pound' },
    ];
}

// ── Rates Management ──────────────────────────────────────────────────────

function getRates(): Record<CurrencyCode, number> {
    try {
        const raw = localStorage.getItem(RATES_KEY);
        return raw ? JSON.parse(raw) : DEFAULT_RATES;
    } catch {
        return DEFAULT_RATES;
    }
}

/** Update rates from an external source (call when online) */
export function updateRates(rates: Partial<Record<CurrencyCode, number>>): void {
    const current = getRates();
    const updated = { ...current, ...rates };
    try {
        localStorage.setItem(RATES_KEY, JSON.stringify(updated));
        localStorage.setItem(RATES_UPDATED_KEY, new Date().toISOString());
    } catch {
        /* full */
    }
}

/** Get when rates were last updated */
export function getRatesAge(): string | null {
    try {
        return localStorage.getItem(RATES_UPDATED_KEY);
    } catch {
        return null;
    }
}

// ── Currency Conversion ───────────────────────────────────────────────────

/**
 * Convert an amount between currencies.
 * Uses offline-cached rates (defaults to hardcoded Pacific rates).
 */
export function convertCurrency(amount: number, from: CurrencyCode, to: CurrencyCode): number {
    if (from === to) return amount;
    const rates = getRates();

    // Convert to AUD first (base), then to target
    const inAud = amount / rates[from];
    const result = inAud * rates[to];
    return Math.round(result * 100) / 100;
}

/** Format a currency value with symbol */
export function formatCurrency(amount: number, code: CurrencyCode): string {
    const symbol = getCurrencySymbol(code);
    return `${symbol}${amount.toFixed(2)}`;
}

// ── Weight Conversion ─────────────────────────────────────────────────────

const KG_TO_LB = 2.20462;
const KG_TO_OZ = 35.274;

export function kgToLb(kg: number): number {
    return Math.round(kg * KG_TO_LB * 100) / 100;
}

export function lbToKg(lb: number): number {
    return Math.round((lb / KG_TO_LB) * 100) / 100;
}

export function kgToOz(kg: number): number {
    return Math.round(kg * KG_TO_OZ * 10) / 10;
}

export function convertWeight(value: number, from: 'kg' | 'lb' | 'oz' | 'g', to: 'kg' | 'lb' | 'oz' | 'g'): number {
    if (from === to) return value;
    // Normalise to kg
    let inKg = value;
    if (from === 'lb') inKg = value / KG_TO_LB;
    else if (from === 'oz') inKg = value / KG_TO_OZ;
    else if (from === 'g') inKg = value / 1000;

    // Convert from kg
    if (to === 'kg') return Math.round(inKg * 100) / 100;
    if (to === 'lb') return Math.round(inKg * KG_TO_LB * 100) / 100;
    if (to === 'oz') return Math.round(inKg * KG_TO_OZ * 10) / 10;
    if (to === 'g') return Math.round(inKg * 1000);
    return value;
}

// ── Volume Conversion ─────────────────────────────────────────────────────

const L_TO_GAL = 0.264172; // US gallon
const L_TO_QT = 1.05669;
const L_TO_FLOZ = 33.814;

export function convertVolume(
    value: number,
    from: 'L' | 'ml' | 'gal' | 'qt' | 'floz',
    to: 'L' | 'ml' | 'gal' | 'qt' | 'floz',
): number {
    if (from === to) return value;
    // Normalise to litres
    let inL = value;
    if (from === 'ml') inL = value / 1000;
    else if (from === 'gal') inL = value / L_TO_GAL;
    else if (from === 'qt') inL = value / L_TO_QT;
    else if (from === 'floz') inL = value / L_TO_FLOZ;

    if (to === 'L') return Math.round(inL * 100) / 100;
    if (to === 'ml') return Math.round(inL * 1000);
    if (to === 'gal') return Math.round(inL * L_TO_GAL * 100) / 100;
    if (to === 'qt') return Math.round(inL * L_TO_QT * 100) / 100;
    if (to === 'floz') return Math.round(inL * L_TO_FLOZ * 10) / 10;
    return value;
}

// ── Length/Distance Conversion ────────────────────────────────────────────

const M_TO_FT = 3.28084;
const NM_TO_M = 1852;

export function convertLength(
    value: number,
    from: 'm' | 'ft' | 'nm' | 'km' | 'mi',
    to: 'm' | 'ft' | 'nm' | 'km' | 'mi',
): number {
    if (from === to) return value;
    // Normalise to metres
    let inM = value;
    if (from === 'ft') inM = value / M_TO_FT;
    else if (from === 'nm') inM = value * NM_TO_M;
    else if (from === 'km') inM = value * 1000;
    else if (from === 'mi') inM = value * 1609.344;

    if (to === 'm') return Math.round(inM * 100) / 100;
    if (to === 'ft') return Math.round(inM * M_TO_FT * 100) / 100;
    if (to === 'nm') return Math.round((inM / NM_TO_M) * 100) / 100;
    if (to === 'km') return Math.round((inM / 1000) * 100) / 100;
    if (to === 'mi') return Math.round((inM / 1609.344) * 100) / 100;
    return value;
}

// ── Temperature ───────────────────────────────────────────────────────────

export function celsiusToFahrenheit(c: number): number {
    return Math.round((c * 9) / 5 + 32);
}

export function fahrenheitToCelsius(f: number): number {
    return Math.round(((f - 32) * 5) / 9);
}

// ── User Preferences ──────────────────────────────────────────────────────

const DEFAULT_PREFS: UnitPreferences = {
    currency: 'AUD',
    unitSystem: 'metric',
};

export function getUnitPreferences(): UnitPreferences {
    try {
        const raw = localStorage.getItem(PREFS_KEY);
        return raw ? { ...DEFAULT_PREFS, ...JSON.parse(raw) } : DEFAULT_PREFS;
    } catch {
        return DEFAULT_PREFS;
    }
}

export function setUnitPreferences(prefs: Partial<UnitPreferences>): void {
    const current = getUnitPreferences();
    const updated = { ...current, ...prefs };
    try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(updated));
    } catch {
        /* full */
    }
}

// ── Smart Display Helper ──────────────────────────────────────────────────

/**
 * Format a store item quantity with the user's preferred unit system.
 * Auto-detects metric/imperial and converts.
 */
export function formatStoresQuantity(quantity: number, unit: string, targetSystem?: UnitSystem): string {
    const system = targetSystem || getUnitPreferences().unitSystem;

    if (system === 'imperial') {
        const u = unit.toLowerCase();
        if (u === 'kg') return `${kgToLb(quantity)} lb`;
        if (u === 'g') return `${convertWeight(quantity, 'g', 'oz')} oz`;
        if (u === 'l' || u === 'litre' || u === 'liter') return `${convertVolume(quantity, 'L', 'gal')} gal`;
        if (u === 'ml') return `${convertVolume(quantity, 'ml', 'floz')} fl oz`;
        if (u === 'm') return `${convertLength(quantity, 'm', 'ft')} ft`;
    }

    return `${quantity} ${unit}`;
}
