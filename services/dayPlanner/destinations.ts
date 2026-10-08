/**
 * Hand-reviewed activity facts for the Whitsundays pilot, not approach points.
 * Positions and anchorage identities come unchanged from the existing QLD tile.
 * An activity match never establishes safe access, permission or availability.
 * See docs/day-planner-destinations.md for provenance and maintenance rules.
 */
export type DayPlannerActivity = 'snorkel' | 'beach' | 'walk' | 'lunch' | 'quiet' | 'explore';
export type CompassPoint = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW';

export interface DayPlannerDestination {
    id: string;
    name: string;
    /** Existing anchorage reference position, not a landing or anchor-drop point. */
    lat: number;
    lon: number;
    activities: DayPlannerActivity[];
    summary: string;
    sourceUrl: string;
    sourceLabel: string;
    /** Omitted for unreviewed mapped references; never infer an activity review. */
    verifiedAt?: string;
    /** Source retrieval timestamp, not verification of activities or access. */
    retrievedAt?: string;
    catalogueQuality?: 'reviewed' | 'mapped-reference' | 'catalogue-reference';
    /** IANA timezone for local calendar dates, especially access notices. */
    timeZone?: string;
    /** Public map link for the exact source feature, when available. */
    openMapUrl?: string;
    accessNotes: string[];
    uncertaintyNotes: string[];
    anchorageId: string;
    anchorageName: string;
    referencePosition: 'existing-anchorage' | 'catalogue-reference';
    supportingSources?: { url: string; label: string }[];
    /** Inclusive destination-local dates; omit these candidates during this period. */
    knownClosures?: { fromDate: string; throughDate: string; reason: string; sourceUrl: string }[];
    /** The source's own landing note, machine-readable: set only where its
     *  prose says "mid to high tide". Plan Your Day turns it into an approximate
     *  window from the local tide curve; it never establishes a safe landing. */
    landingTide?: 'mid-to-high';
    /** The winds the source's own access note says make access difficult,
     *  machine-readable: set only where its prose names one (Chance Bay's
     *  south-easterlies, Maureen's Cove's northerlies). Plan Your Day holds
     *  the stop at "Some chop" when the wind is from there; the land around
     *  it may say otherwise, and the note is the reviewed fact. */
    accessWinds?: readonly CompassPoint[];
}

export interface ReviewedDayPlannerDestination extends DayPlannerDestination {
    /** Date activity facts were reviewed; not a live access or weather check. */
    verifiedAt: string;
    catalogueQuality: 'reviewed';
}

const VERIFIED_AT = '2026-09-27';
const PARK = 'https://parks.qld.gov.au/parks/whitsunday-islands';
const POSITION_NOTE =
    'Position is an existing mapped anchorage reference, not a verified approach, landing or anchor-drop position.';
const ACCESS_NOTE =
    'Check current park alerts, marine restrictions and local conditions; this catalogue does not establish safe access or mooring availability.';
const WATER_NOTE =
    'Snorkelling visibility, currents, wildlife hazards and suitability for your group are not verified.';
const PICNIC_NOTE = 'Lunch means a bring-your-own picnic; food service and table availability are not verified.';
const QUIET_NOTE = 'Quiet is a preference match for a slower stop; crowd levels and calm water are not verified.';

/** The catalogue's own boilerplate, true of every stop. Plan Your Day shows
 *  each stop's OWN notes on its detail; these are said there once, as "Not a
 *  clearance", and in Sources' "Not checked" (the activity tags they qualify
 *  are not shown). */
export const SHARED_DESTINATION_NOTES: ReadonlySet<string> = new Set([
    POSITION_NOTE,
    ACCESS_NOTE,
    WATER_NOTE,
    PICNIC_NOTE,
    QUIET_NOTE,
]);

export const WHITSUNDAYS_DAY_DESTINATIONS: readonly ReviewedDayPlannerDestination[] = [
    {
        id: 'whitehaven-beach',
        name: 'Whitehaven Beach',
        lat: -20.26827,
        lon: 149.05133,
        activities: ['beach', 'walk', 'lunch'],
        summary: 'Beach time, a picnic and the walking tracks near the Whitehaven day-use area.',
        sourceUrl: `${PARK}/attractions/whitehaven-beach-day-use-area`,
        sourceLabel: 'Queensland Parks · Whitehaven Beach day-use area',
        verifiedAt: VERIFIED_AT,
        catalogueQuality: 'reviewed',
        timeZone: 'Australia/Brisbane',
        accessNotes: [
            'The mapped Whitehaven Bay reference is offshore; confirm the separate transfer to the day-use area.',
            PICNIC_NOTE,
            ACCESS_NOTE,
        ],
        uncertaintyNotes: [POSITION_NOTE, 'A beach activity tag does not establish swimming safety.'],
        anchorageId: 'osm-node2982151597',
        anchorageName: 'Whitehaven Bay',
        referencePosition: 'existing-anchorage',
    },
    {
        id: 'tongue-bay-hill-inlet',
        name: 'Tongue Bay · Hill Inlet lookout',
        lat: -20.24273,
        lon: 149.01398,
        activities: ['walk', 'beach'],
        summary: 'The Hill Inlet lookout walk and the connecting Lookout Beach track.',
        sourceUrl: `${PARK}/journeys/hill-inlet-lookout-track`,
        sourceLabel: 'Queensland Parks · Hill Inlet lookout track',
        verifiedAt: VERIFIED_AT,
        catalogueQuality: 'reviewed',
        timeZone: 'Australia/Brisbane',
        accessNotes: [
            'Queensland Parks describes shore access from mid to high tide; a suitable landing still needs checking.',
            'Published works at Tongue Point on 12–16 October 2026 may close sections of facilities; check the linked alert.',
            ACCESS_NOTE,
        ],
        uncertaintyNotes: [POSITION_NOTE, 'Track and beach access are not verified for the planned arrival time.'],
        anchorageId: 'osm-node13823198736',
        anchorageName: 'Tongue Bay',
        landingTide: 'mid-to-high',
        referencePosition: 'existing-anchorage',
        supportingSources: [
            { url: `${PARK}/things-to-do`, label: 'Queensland Parks · Lookout Beach track' },
            { url: 'https://parks.qld.gov.au/park-alerts/26977', label: 'Queensland Parks · Tongue Point works' },
        ],
    },
    {
        id: 'chance-bay',
        name: 'Chance Bay',
        lat: -20.30413,
        lon: 149.04268,
        activities: ['snorkel', 'beach', 'walk', 'lunch', 'quiet'],
        summary: 'A sandy beach with picnic facilities, a walking-track connection and documented snorkelling.',
        sourceUrl: `${PARK}/camping/chance-bay-whitsunday-island`,
        sourceLabel: 'Queensland Parks · Chance Bay',
        verifiedAt: VERIFIED_AT,
        catalogueQuality: 'reviewed',
        timeZone: 'Australia/Brisbane',
        accessNotes: [
            'Queensland Parks describes boat access at mid to high tide and warns that south-easterly winds can make access difficult.',
            PICNIC_NOTE,
            ACCESS_NOTE,
        ],
        uncertaintyNotes: [POSITION_NOTE, WATER_NOTE, QUIET_NOTE],
        anchorageId: 'osm-node8925547809',
        anchorageName: 'Chance Bay',
        landingTide: 'mid-to-high',
        accessWinds: ['SE'],
        referencePosition: 'existing-anchorage',
    },
    {
        id: 'cid-harbour-sawmill',
        name: 'Cid Harbour · Sawmill Beach',
        lat: -20.24511,
        lon: 148.94836,
        activities: ['walk', 'lunch', 'quiet'],
        summary: 'A picnic at Sawmill Beach and a walk on the Dugong–Sawmill track.',
        sourceUrl: `${PARK}/attractions/sawmill-beach-day-use-area`,
        sourceLabel: 'Queensland Parks · Sawmill Beach day-use area',
        verifiedAt: VERIFIED_AT,
        catalogueQuality: 'reviewed',
        timeZone: 'Australia/Brisbane',
        accessNotes: [
            'Do not swim in Cid Harbour: Queensland Parks warns of dangerous sharks and potentially fatal attacks.',
            'Queensland Parks describes shore access at mid to high tide. The harbour reference is not a beach landing.',
            PICNIC_NOTE,
            ACCESS_NOTE,
        ],
        uncertaintyNotes: [POSITION_NOTE, QUIET_NOTE],
        anchorageId: 'osm-node3020491514',
        anchorageName: 'Cid Harbour',
        landingTide: 'mid-to-high',
        referencePosition: 'existing-anchorage',
        supportingSources: [{ url: `${PARK}/camping`, label: 'Queensland Parks · Cid Harbour shark warning' }],
    },
    {
        id: 'nara-inlet-cultural-site',
        name: 'Nara Inlet · Ngaro Cultural Site',
        lat: -20.1374,
        lon: 148.91214,
        activities: ['walk'],
        summary: 'A short, stepped walk to the Ngaro Cultural Site viewing platform.',
        sourceUrl: `${PARK}/journeys/ngaro-cultural-site-track`,
        sourceLabel: 'Queensland Parks · Ngaro Cultural Site track',
        verifiedAt: VERIFIED_AT,
        catalogueQuality: 'reviewed',
        timeZone: 'Australia/Brisbane',
        accessNotes: [
            'Queensland Parks describes mid-tide shore access and an initially steep track in the upper inlet; confirm the landing separately.',
            'The Ngaro Cultural Site closes 08:00–15:00 on 6–15 October 2026; a southern Hook Island maritime exclusion zone also applies.',
            ACCESS_NOTE,
        ],
        uncertaintyNotes: [POSITION_NOTE, 'A mapped inlet stop does not verify access to the cultural site.'],
        anchorageId: 'osm-node2838871153',
        anchorageName: 'Nara Inlet',
        referencePosition: 'existing-anchorage',
        supportingSources: [
            { url: 'https://parks.qld.gov.au/park-alerts/26934', label: 'Queensland Parks · Hook Island closure' },
        ],
        knownClosures: [
            {
                fromDate: '2026-10-06',
                throughDate: '2026-10-15',
                reason: 'Cultural-site daytime closure and southern Hook Island maritime exclusion zone.',
                sourceUrl: 'https://parks.qld.gov.au/park-alerts/26934',
            },
        ],
    },
    {
        id: 'maureens-cove',
        name: 'Maureen’s Cove',
        lat: -20.06774,
        lon: 148.93815,
        activities: ['snorkel', 'lunch'],
        summary: 'Documented fringing-reef snorkelling and picnic facilities above a coral-rubble beach.',
        sourceUrl: `${PARK}/camping/maureens-cove-hook-island`,
        sourceLabel: 'Queensland Parks · Maureen’s Cove',
        verifiedAt: VERIFIED_AT,
        catalogueQuality: 'reviewed',
        timeZone: 'Australia/Brisbane',
        accessNotes: [
            'Queensland Parks describes mid- to high-tide shore access and exposure to strong northerlies.',
            'Reef-protection markers restrict anchoring. Confirm the current boundaries and any mooring conditions locally.',
            PICNIC_NOTE,
            ACCESS_NOTE,
        ],
        uncertaintyNotes: [POSITION_NOTE, WATER_NOTE],
        anchorageId: 'osm-node2838870585',
        anchorageName: "Maureen's Cove",
        landingTide: 'mid-to-high',
        accessWinds: ['N'],
        referencePosition: 'existing-anchorage',
    },
];
