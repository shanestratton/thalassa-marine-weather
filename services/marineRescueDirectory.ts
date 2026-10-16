/** Manual rescue-contact suggestions, never automatic rescue messaging.
 * Approximate rectangles are a prompt to review an operator's published details,
 * not SAR jurisdiction. Older entries retain their inherited source citation;
 * that citation alone is not a new verification of every number.
 * The overdue watch uses only the separately reviewed region advice below.
 * Current primary sources distinguish MRQ assistance from000/VHF16 emergencies,
 * and USCG911/regional RCC contact from an old regional Captain-of-the-Port number.
 */

export interface MarineRescueService {
    /** Name as a shore contact should say it down the phone. */
    service: string;
    phone: string;
    /** VHF working channel, where a published one exists. */
    vhf?: string;
    /** Plain-language coverage, shown to the skipper so they can judge it. */
    coverage: string;
    /** [south, west, north, east] in degrees. Routing only — see above. */
    box: [number, number, number, number];
    /** Higher wins where boxes overlap. State > national > international. */
    rank: number;
    /** Source provenance; inherited entries are not newly verified. */
    source: string;
    purpose?: 'assistance' | 'emergency-local' | 'search-and-rescue';
    dialingContext?: string;
}

/**
 * Ordered by region. New corrections require the operator's primary source
 * and an explicit purpose/dialling context; inherited citations remain visible.
 */
export const MARINE_RESCUE_SERVICES: readonly MarineRescueService[] = [
    {
        service: 'Marine Rescue Queensland',
        phone: '131 677',
        vhf: 'VHF 16',
        coverage: 'Queensland assistance · emergencies: 000 or VHF 16',
        box: [-29.2, 137.9, -9.0, 154.5],
        rank: 20,
        source: 'https://www.mrq.qld.gov.au/contact-us',
        purpose: 'assistance',
        dialingContext: '131 677 is assistance in Australia. Emergency: 000 or VHF 16.',
    },
    {
        service: 'Marine Rescue NSW',
        phone: '(02) 8071 4848',
        vhf: 'VHF 16',
        coverage: 'New South Wales coastal waters · State Headquarters',
        box: [-37.6, 140.9, -28.1, 154.2],
        rank: 20,
        source: 'marinerescuensw.com.au/contact-us — supplied by Shane 2026-09-05',
    },
    {
        service: 'SA SES Marine Rescue',
        phone: '1300 364 587',
        vhf: 'VHF 16',
        coverage: 'South Australian waters · or SA Police 131 444',
        box: [-38.2, 128.9, -25.9, 141.1],
        rank: 20,
        source: 'ses.sa.gov.au/marine — supplied by Shane 2026-09-05',
    },
    {
        service: 'DFES Western Australia',
        phone: '(08) 9395 9300',
        vhf: 'VHF 16',
        coverage: 'Western Australian waters · State Head Office',
        box: [-35.3, 112.8, -13.5, 129.1],
        rank: 20,
        source: 'DFES State Head Office — supplied by Shane 2026-09-05',
    },
    {
        service: 'Australian Maritime Safety Authority (AMSA) JRCC',
        phone: '1800 641 792',
        vhf: 'VHF 16',
        coverage: 'Australian search and rescue region, including offshore',
        box: [-50.0, 100.0, -5.0, 165.0],
        rank: 10,
        source: 'https://www.amsa.gov.au/about/contact-us',
        purpose: 'search-and-rescue',
        dialingContext: '1800 641 792 within Australia; +61 2 6230 6811 from abroad.',
    },
    {
        service: 'Maritime NZ RCCNZ',
        phone: '+64 4 577 8030',
        vhf: 'VHF 16',
        coverage: 'New Zealand search and rescue region',
        box: [-52.0, 162.0, -29.0, 180.0],
        rank: 10,
        source: 'components/passage/EmergencyPlan.tsx (in-app since before 2026-09)',
    },
    {
        service: 'US Coast Guard',
        phone: '911 (within United States)',
        vhf: 'VHF 16',
        coverage: 'United States waters',
        box: [18.0, -130.0, 50.0, -64.0],
        rank: 10,
        source: 'https://www.dco.uscg.mil/Our-Organization/Assistant-Commandant-for-Response-Policy-CG-5R/Office-of-Incident-Management-Preparedness-CG-5RI/US-Coast-Guard-Office-of-Search-and-Rescue-CG-SAR/Contact-USCG-SAR/',
        purpose: 'emergency-local',
        dialingContext:
            '911 routes by caller location within the US. From abroad use the official regional RCC directory. At sea use VHF 16. Emergency email is not monitored.',
    },
    {
        service: 'HM Coastguard',
        phone: '999 / 112',
        vhf: 'VHF 16',
        coverage: 'United Kingdom waters',
        box: [49.0, -11.0, 61.5, 3.0],
        rank: 10,
        source: 'components/passage/EmergencyPlan.tsx (in-app since before 2026-09)',
    },
    {
        service: 'CROSS (Centre Régional)',
        phone: '196',
        vhf: 'VHF 16',
        coverage: 'French waters',
        box: [41.0, -6.0, 51.5, 10.0],
        rank: 10,
        source: 'components/passage/EmergencyPlan.tsx (in-app since before 2026-09)',
    },
    {
        service: 'BASARNAS (Search & Rescue)',
        phone: '+62 21 348 32908',
        vhf: 'VHF 16',
        coverage: 'Indonesian waters',
        box: [-11.5, 94.0, 6.5, 141.5],
        rank: 10,
        source: 'components/passage/EmergencyPlan.tsx (in-app since before 2026-09)',
    },
    {
        service: 'PNG National Maritime Safety Authority',
        phone: '+675 320 0211',
        vhf: 'VHF 16',
        coverage: 'Papua New Guinea waters',
        box: [-12.0, 140.0, -1.0, 156.0],
        rank: 10,
        source: 'components/passage/EmergencyPlan.tsx (in-app since before 2026-09)',
    },
    {
        service: 'Fiji Navy MRCC',
        phone: '+679 331 5470',
        vhf: 'VHF 16',
        coverage: 'Fiji waters',
        box: [-21.0, 176.0, -15.0, 180.0],
        rank: 10,
        source: 'components/passage/EmergencyPlan.tsx (in-app since before 2026-09)',
    },
];

export interface MarineRescueSuggestion {
    service: MarineRescueService;
    /** Ready for the float plan's free-text field. */
    text: string;
}

const inBox = (lat: number, lon: number, box: MarineRescueService['box']): boolean =>
    lat >= box[0] && lat <= box[2] && lon >= box[1] && lon <= box[3];

/**
 * The service to suggest for a position, or null when none covers it.
 *
 * NULL IS A REAL ANSWER, and the important one. Mid-Pacific, mid-Atlantic, the
 * Southern Ocean — there is no local number to dial, and inventing one would be
 * worse than saying nothing. The caller leaves the field blank so the skipper
 * fills it in themselves, which is what they would have done anyway.
 */
export function suggestMarineRescue(lat: number, lon: number): MarineRescueSuggestion | null {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

    let best: MarineRescueService | null = null;
    for (const candidate of MARINE_RESCUE_SERVICES) {
        if (!inBox(lat, lon, candidate.box)) continue;
        if (!best || candidate.rank > best.rank) best = candidate;
    }
    if (!best) return null;

    return {
        service: best,
        text: `${best.service} · ${best.phone}${best.dialingContext ? ` · ${best.dialingContext}` : ''}`,
    };
}
/** Owner-reviewed region, not a claim about legal SAR jurisdiction or current boat location. */
export const REVIEWED_RESCUE_ADVICE = {
    au: {
        label: 'Australia — AMSA JRCC',
        purpose: 'search-and-rescue',
        text: 'Concern about a vessel in the Australian search-and-rescue region: AMSA maritime SAR, 1800 641 792 within Australia; +61 2 6230 6811 from abroad.',
        source: 'https://www.amsa.gov.au/about/contact-us',
    },
    nz: {
        label: 'New Zealand — RCCNZ',
        purpose: 'search-and-rescue',
        text: 'RCCNZ: 0508 472 269 within New Zealand; +64 4 577 8030 from abroad.',
        source: 'https://www.maritimenz.govt.nz/readiness-and-response/maritime-incident-readiness-and-response-mirr/rescue-coordination-centre-rccnz/',
    },
    us: {
        label: 'United States — local emergency/RCC',
        purpose: 'emergency-local',
        text: 'Within the United States call 911; at sea use VHF 16. From abroad choose the relevant regional RCC on the official USCG contact page. 911 routes by caller location; it is not an international maritime number. Do not email a SAR emergency.',
        source: 'https://www.dco.uscg.mil/Our-Organization/Assistant-Commandant-for-Response-Policy-CG-5R/Office-of-Incident-Management-Preparedness-CG-5RI/US-Coast-Guard-Office-of-Search-and-Rescue-CG-SAR/Contact-USCG-SAR/',
    },
    uk: {
        label: 'United Kingdom — Coastguard',
        purpose: 'emergency-local',
        text: 'Within the United Kingdom call 999 or 112 and ask for Coastguard; at sea use VHF 16. These numbers route by caller location and are not overseas direct lines.',
        source: 'https://www.gov.uk/guidance/999-and-112-the-uks-national-emergency-numbers',
    },
    fr: {
        label: 'France — CROSS',
        purpose: 'emergency-local',
        text: 'In France call 196 for CROSS; at sea use VHF 16. The short number is not an overseas direct line.',
        source: 'https://www.mer.gouv.fr/surveillance-et-sauvetage-en-mer',
    },
} as const;
export function reviewedRescueWords(region: string | null): string {
    const row =
        region && Object.hasOwn(REVIEWED_RESCUE_ADVICE, region)
            ? REVIEWED_RESCUE_ADVICE[region as keyof typeof REVIEWED_RESCUE_ADVICE]
            : null;
    return row
        ? `Owner-selected rescue advice (verify region and current details before calling): ${row.text} Source: ${row.source}. This service has not contacted any rescue agency.`
        : 'Rescue contact unavailable for the selected region. Check the relevant official maritime rescue authority manually. This service has not contacted any rescue agency.';
}
