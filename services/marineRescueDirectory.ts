/**
 * Which rescue number to suggest for a float plan, from where the boat is.
 *
 * Shane, 2026-09-05: "can we auto fill the Raise the Alarm section of the Float
 * Plan claude with the closest marine rescue phone number."
 *
 * WHAT THIS DELIBERATELY IS NOT. It is not a directory of local squadrons. A
 * float plan's overdue number is the one thing on the page that gets dialled
 * in an emergency, and an invented or mistyped number there is worse than a
 * blank field — the blank field makes someone look it up. So every entry
 * carries a `source`, and nothing goes in without one.
 *
 * The Australian state numbers were supplied by Shane with citations on
 * 2026-09-05, which also CORRECTED one this file had wrong: VMR Queensland and
 * the Australian Volunteer Coast Guard have merged into Marine Rescue
 * Queensland, hotline 131 677. The 07 3635 3600 inherited from
 * EmergencyPlan.tsx is superseded, and has been fixed there too — an emergency
 * list is exactly where a stale number does the most harm.
 *
 * It is also the CORRECT call for an overdue vessel. In Australia that is the
 * state marine rescue coordination centre or the JRCC, not the nearest
 * volunteer squadron's clubhouse line — a squadron may be unattended, while a
 * coordination centre is staffed and can task whoever is closest. So
 * "closest" here means the nearest coordinating authority, which is the number
 * a shore contact should actually ring.
 *
 * THE BOXES ARE ROUTING, NOT JURISDICTION. They pick the most relevant
 * published number for a position; they do not describe who is legally
 * responsible for a search, and they must never be presented as though they
 * do. Where boxes overlap, `rank` decides: a state service beats the national
 * one inside its own waters, and the national one covers everything else.
 *
 * The suggestion is always editable and never overwrites what a skipper typed.
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
    /** Where this number was verified. Required — see the note above. */
    source: string;
}

/**
 * Ordered loosely by region for reading, not by precedence — precedence is
 * `rank`. Adding an entry means adding a number that will be dialled by
 * someone who is worried: confirm it against the operator's own published
 * contact page and put that page in `source`. A test refuses an entry without
 * one.
 */
export const MARINE_RESCUE_SERVICES: readonly MarineRescueService[] = [
    {
        service: 'Marine Rescue Queensland',
        phone: '131 677',
        vhf: 'VHF 16',
        coverage: 'Queensland coastal waters · 131 MRQ',
        box: [-29.2, 137.9, -9.0, 154.5],
        rank: 20,
        source: 'mrq.qld.gov.au — supplied by Shane 2026-09-05',
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
        source: 'components/passage/EmergencyPlan.tsx (in-app since before 2026-09)',
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
        phone: '1-800-221-8724',
        vhf: 'VHF 16',
        coverage: 'United States waters',
        box: [18.0, -130.0, 50.0, -64.0],
        rank: 10,
        source: 'components/passage/EmergencyPlan.tsx (in-app since before 2026-09)',
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

    return { service: best, text: `${best.service} · ${best.phone}` };
}
