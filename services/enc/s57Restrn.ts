/**
 * S-57 RESTRN (Restriction, attribute code 131): the ONE code table the chart
 * popup (components/map/encPopup.ts) and the route advisories
 * (services/isochrone/landAvoidance.ts describeCautionCrossings) both read.
 *
 * They used to keep separate partial copies, and both called 14 "no wake".
 * The meanings below are the IHO's, verbatim, checked against S-57 Appendix A,
 * Chapter 2 (Attributes), Edition 3.1, November 2000, page 2.177:
 * https://iho.int/uploads/user/pubs/standards/s-57/31ApAch2.pdf
 * Every hydrographic office charts these same codes, so the table is global.
 */

/** IHO S-57 Edition 3.1 RESTRN expected input, codes 1-27. */
export const S57_RESTRN_MEANINGS: Readonly<Record<string, string>> = {
    '1': 'anchoring prohibited',
    '2': 'anchoring restricted',
    '3': 'fishing prohibited',
    '4': 'fishing restricted',
    '5': 'trawling prohibited',
    '6': 'trawling restricted',
    '7': 'entry prohibited',
    '8': 'entry restricted',
    '9': 'dredging prohibited',
    '10': 'dredging restricted',
    '11': 'diving prohibited',
    '12': 'diving restricted',
    '13': 'no wake',
    // An IMO "area to be avoided", a routeing measure (M-4 435.7).
    '14': 'area to be avoided',
    '15': 'construction prohibited',
    '16': 'discharging prohibited',
    '17': 'discharging restricted',
    '18': 'industrial or mineral exploration/development prohibited',
    '19': 'industrial or mineral exploration/development restricted',
    '20': 'drilling prohibited',
    '21': 'drilling restricted',
    '22': 'removal of historical artifacts prohibited',
    '23': 'cargo transhipment (lightering) prohibited',
    '24': 'dragging prohibited',
    '25': 'stopping prohibited',
    '26': 'landing prohibited',
    '27': 'speed restricted',
};

/**
 * Codes that make a route crossing a CAUTION rather than a note: entry
 * prohibited (7), entry restricted (8) and an area to be avoided (14). Taking
 * a route through any of them needs a look, not just a caveat.
 */
export const RESTRN_ROUTE_CAUTION_CODES: ReadonlySet<string> = new Set(['7', '8', '14']);

/**
 * The codes of a RESTRN value. It is an S-57 list attribute, so a converter
 * hands it over as "7,14", as [7, 14] or as a single number; a zero-padded
 * "07" is code 7.
 */
export function restrnCodes(raw: unknown): string[] {
    return String(raw ?? '')
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean)
        .map((c) => (/^\d+$/.test(c) ? String(Number(c)) : c));
}

/** The S-57 meaning of one code, lower case. An unknown code stays look-up-able on a paper chart. */
export function restrnMeaning(code: string): string {
    return S57_RESTRN_MEANINGS[code] ?? `restriction code ${code}`;
}
