
// --- Specific Converters (Testable) ---

export const ktsToMph = (kts: number) => kts * 1.15078;
export const ktsToKmh = (kts: number) => kts * 1.852;
export const ktsToMps = (kts: number) => kts * 0.514444;

export const ftToM = (ft: number) => ft * 0.3048;
export const mToFt = (m: number) => m * 3.28084;

export const kgToLbs = (kg: number) => kg * 2.20462;
export const lbsToKg = (lbs: number) => lbs * 0.453592;

export const celsiusToFahrenheit = (c: number) => (c * 9 / 5) + 32;
export const fahrenheitToCelsius = (f: number) => (f - 32) * 5 / 9;

// --- Generic "Model to View" Converters ---

export const convertSpeed = (kts: number | null | undefined, unit: string) => {
    if (kts === null || kts === undefined) return null;
    if (unit === 'mph') return parseFloat(ktsToMph(kts).toFixed(1));
    if (unit === 'kmh') return parseFloat(ktsToKmh(kts).toFixed(1));
    if (unit === 'mps') return parseFloat(ktsToMps(kts).toFixed(1));
    return parseFloat(kts.toFixed(1));
};

export const convertLength = (ft: number | null | undefined, unit: string) => {
    if (ft === null || ft === undefined) return null;
    if (unit === 'm') return parseFloat(ftToM(ft).toFixed(1));
    return parseFloat(ft.toFixed(1));
};

export const convertWeight = (lbs: number | null | undefined, unit: string) => {
    if (lbs === null || lbs === undefined) return null;
    if (unit === 'kg') return parseFloat(lbsToKg(lbs).toFixed(0));
    if (unit === 'tonnes') return parseFloat((lbs * 0.000453592).toFixed(2));
    return parseFloat(lbs.toFixed(0));
};

export const convertTemp = (val: number | null | undefined, unit: string) => {
    if (val === undefined || val === null) return '--';

    // API always returns Celsius. Convert if unit is F.
    if (unit === 'F') {
        const f = celsiusToFahrenheit(val);
        return f.toFixed(0);
    }

    return val.toFixed(0);
};

export const convertDistance = (nauticalMiles: number | null | undefined, unit: string) => {
    if (nauticalMiles === undefined || nauticalMiles === null) return '--';
    let val = nauticalMiles;
    if (unit === 'km') val = nauticalMiles * 1.852;
    if (unit === 'mi') val = nauticalMiles * 1.15078;
    // if unit is 'nm', val is already nm
    return val.toFixed(1);
}

export const convertMetersTo = (meters: number | null | undefined, targetUnit: string) => {
    if (meters === undefined || meters === null) return null;
    if (targetUnit === 'ft') return parseFloat(mToFt(meters).toFixed(1));
    return parseFloat(meters.toFixed(1));
};

export const convertPrecip = (mm: number | null | undefined, tempUnit: string) => {
    // Filter noise: StormGlass often returns 0.1-0.2mm for "cloud condensation" or model noise.
    // User requested TRACE for < 0.25mm
    if (mm === undefined || mm === null) return null;
    if (mm > 0 && mm < 0.25) return "TRACE";
    if (mm === 0) return null;

    if (tempUnit === 'F') {
        const inches = mm * 0.0393701;
        if (inches < 0.01) return '<0.01"';
        return `${inches.toFixed(2)}"`;
    }
    return `${mm.toFixed(1)}`;
}
