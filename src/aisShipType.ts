/**
 * AIS ship type — one place that knows the ITU-R M.1371 code table.
 *
 * THIS EXISTS BECAUSE THE PUBLIC PAGE WENT BLANK (Shane 2026-09-02: "the
 * public page is not working, it looks like it has hung"). The AIS pond stores
 * the ship type as the raw integer code the transponder sends (36 = sailing,
 * 70 = cargo). The map's colour classifier did `(shipType ?? '').toLowerCase()`
 * — `??` only catches null/undefined, so 36 sailed straight through and
 * `(36).toLowerCase()` threw inside render, taking the whole page down with
 * it. It lay dormant while AIS was gated to the active trip; the morning it
 * started rendering on the latest trip, it fired.
 *
 * Every consumer now comes through here and accepts a number, a numeric
 * string, a descriptive string, or nothing — and none of them can throw.
 */

export type ShipCategory =
    | 'tanker'
    | 'cargo'
    | 'passenger'
    | 'fishing'
    | 'sailing'
    | 'pleasure'
    | 'hsc'
    | 'service'
    | 'military'
    | 'other';

/** ITU-R M.1371 first-digit / exact-code table, reduced to what a punter cares about. */
function categoryFromCode(code: number): ShipCategory | null {
    if (!Number.isFinite(code) || code <= 0) return null;
    if (code === 30) return 'fishing';
    if (code === 31 || code === 32) return 'service'; // towing
    if (code === 35) return 'military';
    if (code === 36) return 'sailing';
    if (code === 37) return 'pleasure';
    if (code >= 40 && code <= 49) return 'hsc';
    if (code >= 50 && code <= 59) return 'service'; // pilot, SAR, tug, tender, law, medical
    if (code >= 60 && code <= 69) return 'passenger';
    if (code >= 70 && code <= 79) return 'cargo';
    if (code >= 80 && code <= 89) return 'tanker';
    if (code >= 33 && code <= 34) return 'service'; // dredging, diving
    return 'other';
}

/** Descriptive strings from older feeds ("Cargo ship", "Sailing"). */
function categoryFromText(text: string): ShipCategory | null {
    const t = text.toLowerCase();
    if (!t.trim()) return null;
    if (t.includes('tanker')) return 'tanker';
    if (t.includes('cargo')) return 'cargo';
    if (t.includes('passenger')) return 'passenger';
    if (t.includes('fishing')) return 'fishing';
    if (t.includes('sailing') || t.includes('yacht')) return 'sailing';
    if (t.includes('pleasure')) return 'pleasure';
    if (t.includes('high speed') || t.includes('hsc')) return 'hsc';
    if (t.includes('tug') || t.includes('pilot') || t.includes('sar') || t.includes('law') || t.includes('tow'))
        return 'service';
    if (t.includes('military') || t.includes('warship')) return 'military';
    return 'other';
}

/** Never throws, whatever the feed sends. */
export function shipCategory(raw: unknown): ShipCategory | null {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'number') return categoryFromCode(raw);
    if (typeof raw === 'string') {
        const asNumber = Number(raw);
        if (raw.trim() !== '' && Number.isFinite(asNumber)) return categoryFromCode(asNumber);
        return categoryFromText(raw);
    }
    return null;
}

const LABEL: Record<ShipCategory, string> = {
    tanker: 'Tanker',
    cargo: 'Cargo',
    passenger: 'Passenger',
    fishing: 'Fishing',
    sailing: 'Sailing',
    pleasure: 'Pleasure craft',
    hsc: 'High-speed craft',
    service: 'Tug / pilot / service',
    military: 'Military',
    other: 'Vessel',
};

/** A word a punter can read, or null when the feed gave us nothing. "36" is not a label. */
export function shipTypeLabel(raw: unknown): string | null {
    const c = shipCategory(raw);
    return c ? LABEL[c] : null;
}

const COLOR: Record<ShipCategory, string> = {
    tanker: '#f87171', // red
    cargo: '#fbbf24', // amber
    passenger: '#38bdf8', // sky
    fishing: '#34d399', // emerald
    sailing: '#a78bfa', // violet
    pleasure: '#a78bfa',
    hsc: '#f472b6', // pink
    service: '#fb923c', // orange
    military: '#94a3b8',
    other: '#94a3b8', // slate
};

/** Hex fill for an AIS contact's marker. Unknown → slate, never a throw. */
export function vesselColor(raw: unknown): string {
    const c = shipCategory(raw);
    return c ? COLOR[c] : COLOR.other;
}
