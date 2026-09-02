/**
 * Degrees and decimal minutes, the way a position is read over the radio.
 *
 * MobPage and RadioConsolePage each carried a copy of this, and both had the
 * same edge: degrees were truncated first and minutes rounded afterwards, so
 * 19.99999° printed as "19°60.000′" — a position that does not exist, on the
 * two screens where a wrong digit costs the most (audit 2026-09-02). Minutes
 * are now rounded first and a full 60 carries into the degrees.
 */
function degMin(abs: number, minuteDecimals: number): { deg: number; min: number } {
    let deg = Math.floor(abs);
    const scale = 10 ** minuteDecimals;
    let min = Math.round((abs - deg) * 60 * scale) / scale;
    if (min >= 60) {
        deg += 1;
        min -= 60;
    }
    return { deg, min };
}

/** Minutes always show two digits before the point — 05.600′, not 5.600′ —
 *  which is how a DSC set and a chart both write them, and what keeps the
 *  digits column-aligned when a MOB position is read back over the radio. */
const minutes = (min: number, d: number): string => min.toFixed(d).padStart(d + 3, '0');

/** e.g. -19.26 → "19°15.600′S" */
export function formatLatDegMin(dec: number, minuteDecimals = 3): string {
    const { deg, min } = degMin(Math.abs(dec), minuteDecimals);
    return `${deg}°${minutes(min, minuteDecimals)}′${dec >= 0 ? 'N' : 'S'}`;
}

/** e.g. 146.82 → "146°49.200′E"; degrees zero-padded to three, as on a DSC set. */
export function formatLonDegMin(dec: number, minuteDecimals = 3): string {
    const { deg, min } = degMin(Math.abs(dec), minuteDecimals);
    return `${String(deg).padStart(3, '0')}°${minutes(min, minuteDecimals)}′${dec >= 0 ? 'E' : 'W'}`;
}
