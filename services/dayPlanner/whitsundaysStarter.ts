/**
 * Editorial research only. Do not import into planner discovery or convert to
 * catalogue rows automatically. Null positions and absent review credentials
 * are deliberate publication blockers, not values to fill from a geocoder.
 * See docs/WHITSUNDAYS_CATALOGUE_REVIEW.md for evidence scope and open decisions.
 */
interface ResearchSource {
    label: string;
    url: string;
    retrievedOn: '2026-09-28';
    rights: 'notice-found-scope-pending' | 'permission-unresolved';
    rightsNoticeUrl: string | null;
}

const qldCopyright = 'https://www.detsi.qld.gov.au/help/legal/copyright';
const reefSpatialRights = 'https://www.gbrmpa.gov.au/about-us/spatial-data-information-services';
const daydreamTerms = 'https://daydreamisland.com/terms-conditions/';

function source(label: string, url: string, rightsNoticeUrl: string | null = null): ResearchSource {
    return {
        label,
        url,
        retrievedOn: '2026-09-28',
        rights: rightsNoticeUrl ? 'notice-found-scope-pending' : 'permission-unresolved',
        rightsNoticeUrl,
    };
}

export const WHITSUNDAYS_RESEARCH_SOURCES = {
    airlieMarina: source('Port of Airlie marina operator', 'https://www.dalbora.com.au/marinas/port-of-airlie-marina/'),
    daydreamMarina: source('Daydream marina operator', 'https://daydreamisland.com/marina-berthing/', daydreamTerms),
    daydreamBerthing: source(
        'Daydream berthing document linked from current marina page',
        'https://daydreamisland.com/wp-content/uploads/2026/07/Marina-Berthing.pdf',
        daydreamTerms,
    ),
    hamiltonMarina: source(
        'Hamilton Island marina operator',
        'https://www.hamiltonisland.com.au/real-estate-and-marina/marina',
    ),
    naraTrack: source(
        'Queensland Parks: Ngaro Cultural Site track',
        'https://parks.qld.gov.au/parks/whitsunday-islands/journeys/ngaro-cultural-site-track',
        qldCopyright,
    ),
    naraClosure: source(
        'Queensland Parks: southern Hook Island operation',
        'https://parks.qld.gov.au/park-alerts/26934',
        qldCopyright,
    ),
    tongueTrack: source(
        'Queensland Parks: Hill Inlet lookout track',
        'https://parks.qld.gov.au/parks/whitsunday-islands/journeys/hill-inlet-lookout-track',
        qldCopyright,
    ),
    tongueWorks: source(
        'Queensland Parks: Tongue Point maintenance',
        'https://parks.qld.gov.au/park-alerts/26977',
        qldCopyright,
    ),
    whitsundaysMoorings: source(
        'Queensland Government: Whitsundays public mooring and no-anchoring map index',
        'https://www.qld.gov.au/environment/coasts-waterways/marine-parks/public-moorings-reef-protection-areas/public-moorings-and-reef-protection-area-maps/whitsundays-area',
        qldCopyright,
    ),
    reefMooringRules: source(
        'Reef Authority: moorings and no-anchoring areas',
        'https://www.gbrmpa.gov.au/access/moorings-and-no-anchoring-areas',
        reefSpatialRights,
    ),
} as const;

type SourceKey = keyof typeof WHITSUNDAYS_RESEARCH_SOURCES;
type DestinationKey = 'airlie' | 'daydream' | 'hamilton' | 'nara' | 'tongue' | 'butterfly';

interface EditorialDestinationDraft {
    key: DestinationKey;
    name: string;
    /** Informal user vocabulary, not evidence that places share an endpoint. */
    aliases: readonly string[];
    status: 'draft';
    reviewStatus: 'pending';
    position: null;
    summaryDraft: string;
    /** Research leads only; these do not become planner activity tags. */
    activityResearch: readonly string[];
    sourceKeys: readonly SourceKey[];
    /** Identity cross-reference only. Never copies the old position or review. */
    existingDestinationKey: string | null;
    unresolved: readonly string[];
}

export const WHITSUNDAYS_STARTER_DESTINATIONS: readonly EditorialDestinationDraft[] = [
    {
        key: 'airlie',
        name: 'Airlie Beach departure area',
        aliases: ['Airlie'],
        status: 'draft',
        reviewStatus: 'pending',
        position: null,
        summaryDraft: 'Mainland departure-area candidate; a specific marina or anchorage must be selected.',
        activityResearch: ['shore visit', 'provisioning'],
        sourceKeys: ['airlieMarina'],
        existingDestinationKey: null,
        unresolved: [
            'Choose a precise origin: Port of Airlie, Coral Sea Marina and an offshore anchorage are different endpoints.',
            'Source and review the selected endpoint position and its permitted use.',
            'Confirm operator access, berth availability and vessel constraints separately.',
        ],
    },
    {
        key: 'daydream',
        name: 'Daydream Island marina visit',
        aliases: ['Daydream'],
        status: 'draft',
        reviewStatus: 'pending',
        position: null,
        summaryDraft: 'Island visit candidate requiring a confirmed marina booking.',
        activityResearch: ['resort visit'],
        sourceKeys: ['daydreamMarina', 'daydreamBerthing'],
        existingDestinationKey: null,
        unresolved: [
            'Review marina-only island access, operator confirmation, vessel suitability and current visitor inclusions.',
            'Resolve commercial content and linking permissions in the operator terms.',
            'Do not reuse older third-party-hosted berthing rules as current policy.',
        ],
    },
    {
        key: 'hamilton',
        name: 'Hamilton Island marina visit',
        aliases: ['Hamilton', 'Hamo'],
        status: 'draft',
        reviewStatus: 'pending',
        position: null,
        summaryDraft: 'Marina-based island visit candidate, subject to the operator accepting the vessel.',
        activityResearch: ['shore visit', 'dining'],
        sourceKeys: ['hamiltonMarina'],
        existingDestinationKey: null,
        unresolved: [
            'Review the intended arrival endpoint, marina rules and current airport-related maritime notices.',
            'Confirm berth booking and the facilities available to the relevant visitor category.',
            'Resolve rights for any source-derived material before publication.',
        ],
    },
    {
        key: 'nara',
        name: 'Nara Inlet / Ngaro Cultural Site',
        aliases: ['Nara'],
        status: 'draft',
        reviewStatus: 'pending',
        position: null,
        summaryDraft: 'Inlet stop candidate with a separate shore transfer for the Ngaro Cultural Site walk.',
        activityResearch: ['walk'],
        sourceKeys: ['naraTrack', 'naraClosure'],
        existingDestinationKey: 'nara-inlet-cultural-site',
        unresolved: [
            'Reconcile the old mapped anchorage reference with the intended catalogue endpoint and position rights.',
            'Represent the October 2026 shore closure and maritime exclusion before publication.',
            'Review landing access, tides and appropriate cultural-site wording; do not copy cultural artwork.',
        ],
    },
    {
        key: 'tongue',
        name: 'Tongue Bay / Hill Inlet lookout',
        aliases: ['Tongue'],
        status: 'draft',
        reviewStatus: 'pending',
        position: null,
        summaryDraft: 'Bay stop candidate for a separately assessed shore transfer and lookout walk.',
        activityResearch: ['walk'],
        sourceKeys: ['tongueTrack', 'tongueWorks', 'whitsundaysMoorings'],
        existingDestinationKey: 'tongue-bay-hill-inlet',
        unresolved: [
            'Review the endpoint, landing transfer and mooring restrictions without treating the lookout as a boat waypoint.',
            'Represent October 2026 partial works and toilet closure without claiming the entire bay is closed.',
            'Review activity and position rights independently.',
        ],
    },
    {
        key: 'butterfly',
        name: 'Butterfly Bay',
        aliases: ['Butterfly'],
        status: 'draft',
        reviewStatus: 'pending',
        position: null,
        summaryDraft: 'Bay visit candidate requiring a choice of sub-area and current mooring restrictions.',
        activityResearch: ['reef visit — activity evidence pending'],
        sourceKeys: ['whitsundaysMoorings', 'reefMooringRules'],
        existingDestinationKey: null,
        unresolved: [
            'Select East or West Butterfly Bay and review the actual mooring/no-anchoring map extent.',
            'Establish destination-specific activity evidence; a mooring map does not establish snorkelling suitability.',
            'Resolve exact spatial-data rights before copying geometry; verify mooring class, limits and current availability separately.',
        ],
    },
];

interface EditorialTripIdea {
    key: string;
    originKey: 'airlie';
    destinationKey: Exclude<DestinationKey, 'airlie'>;
    status: 'draft';
    reviewStatus: 'pending';
    /** Empty means no reviewed passage exists; never draw a joining line. */
    routeVariants: readonly [];
    requiredReviewDirections: readonly ['outbound', 'return'];
}

export const WHITSUNDAYS_STARTER_TRIP_IDEAS: readonly EditorialTripIdea[] = (
    ['daydream', 'hamilton', 'nara', 'tongue', 'butterfly'] as const
).map((destinationKey) => ({
    key: `airlie-${destinationKey}`,
    originKey: 'airlie',
    destinationKey,
    status: 'draft',
    reviewStatus: 'pending',
    routeVariants: [],
    requiredReviewDirections: ['outbound', 'return'],
}));

export const WHITSUNDAYS_STARTER_REVIEW = {
    formatVersion: 1,
    purpose: 'editorial-research-only',
    status: 'draft',
    reviewStatus: 'pending',
    timeZone: 'Australia/Brisbane',
    preparedOn: '2026-09-28',
    reviewedAt: null,
    reviewDueAt: null,
    reviewerLabel: null,
    publicationReady: false,
    sources: WHITSUNDAYS_RESEARCH_SOURCES,
    destinations: WHITSUNDAYS_STARTER_DESTINATIONS,
    tripIdeas: WHITSUNDAYS_STARTER_TRIP_IDEAS,
} as const;
