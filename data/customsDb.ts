/**
 * Customs clearance guide: its types, its loader and the record lookup.
 *
 * The guide (procedures, contacts, required documents, fees and notes for
 * each covered country) is data, not code, since the build-126 bundle diet:
 * public/data/customs-clearance.json, fetched the first time the customs card
 * opens and kept for the session. public/ is packaged inside the app, so it
 * reads with no signal too. The production build ships a minified copy
 * (scripts/minify-public-scripts.mjs); the public/ file stays readable for
 * editing.
 *
 * Each country's name, flag and ports of entry, the aliases, and
 * isSameCountry live in data/customsPortIndex.ts: they are needed
 * synchronously while screens render, so they stay in JavaScript.
 */
import { CUSTOMS_PORT_INDEX, findCountryKey } from './customsPortIndex';

/* ═══════════════════════════════════════════════════════════════
   COUNTRY CLEARANCE GUIDE
   ═══════════════════════════════════════════════════════════════ */

export interface ClearanceContact {
    name: string;
    phone?: string;
    email?: string;
    vhf?: string;
    website?: string;
    notes?: string;
}

export interface RequiredDocument {
    name: string;
    critical: boolean;
    notes?: string;
}

export interface CountryClearance {
    country: string;
    flag: string;
    departureProcedure: string[];
    arrivalProcedure: string[];
    contacts: ClearanceContact[];
    requiredDocuments: RequiredDocument[];
    yachtExport?: string; // Special rules for exporting your yacht
    importantNotes: string[];
    guideUrl?: string;
    guideLabel?: string;
    portsOfEntry: string[];
    fees?: string;
    difficulty: 'easy' | 'moderate' | 'complex';
}

/** One country in public/data/customs-clearance.json: everything but the
 *  name, flag and ports of entry, which the port index holds. */
export type CountryClearanceDetails = Omit<CountryClearance, 'country' | 'flag' | 'portsOfEntry'>;

export type CustomsClearanceGuide = Readonly<Record<string, CountryClearance>>;

export const CUSTOMS_CLEARANCE_URL = '/data/customs-clearance.json';

/** Join the guide file to the port index: whole records, in index order.
 *  A country missing from either side is left out rather than half-shown. */
export function joinClearance(details: Readonly<Record<string, CountryClearanceDetails>>): CustomsClearanceGuide {
    const guide: Record<string, CountryClearance> = {};
    for (const [key, entry] of Object.entries(CUSTOMS_PORT_INDEX)) {
        const record = Object.prototype.hasOwnProperty.call(details, key) ? details[key] : undefined;
        if (!record || typeof record !== 'object') continue;
        guide[key] = {
            ...record,
            country: entry.country,
            flag: entry.flag,
            portsOfEntry: [...entry.portsOfEntry],
        };
    }
    return guide;
}

type FetchLike = (url: string) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

let loaded: CustomsClearanceGuide | null = null;
let pending: Promise<CustomsClearanceGuide> | null = null;

/** The guide if it has already loaded this session, else null. Lets a card
 *  that opens again paint at once instead of flashing a loading line. */
export function peekCustomsClearance(): CustomsClearanceGuide | null {
    return loaded;
}

/** Fetch the guide once and keep it; a failed read is not kept, so the next
 *  card to open tries again. */
export function loadCustomsClearance(fetchImpl: FetchLike = (url) => fetch(url)): Promise<CustomsClearanceGuide> {
    if (loaded) return Promise.resolve(loaded);
    if (pending) return pending;
    const request = (async () => {
        const res = await fetchImpl(CUSTOMS_CLEARANCE_URL);
        if (!res.ok) throw new Error(`customs clearance guide: HTTP ${res.status}`);
        const body = (await res.json()) as unknown;
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            throw new Error('customs clearance guide: not an object');
        }
        loaded = joinClearance(body as Record<string, CountryClearanceDetails>);
        return loaded;
    })();
    pending = request;
    request.then(
        () => {
            if (pending === request) pending = null;
        },
        () => {
            if (pending === request) pending = null;
        },
    );
    return request;
}

/** The guide record for a country or port name (see findCountryKey for the
 *  matching), once the guide has loaded. */
export function findCountryData(
    country: string | undefined,
    guide: CustomsClearanceGuide | null,
): CountryClearance | undefined {
    const key = findCountryKey(country);
    return key && guide ? guide[key] : undefined;
}

export const difficultyStyle = {
    easy: {
        text: 'text-emerald-400',
        bg: 'bg-emerald-500/10',
        border: 'border-emerald-500/20',
        label: 'Straightforward',
    },
    moderate: {
        text: 'text-amber-400',
        bg: 'bg-amber-500/10',
        border: 'border-amber-500/20',
        label: 'Moderate Paperwork',
    },
    complex: { text: 'text-red-400', bg: 'bg-red-500/10', border: 'border-red-500/20', label: 'Complex — Plan Ahead' },
};
