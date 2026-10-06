/**
 * "A year in the life" captions for the month readout. DATA keyed by story
 * id (regions.ts names which story belongs to which region), so another coast
 * gets its own year without touching code. General natural history, written
 * plainly, not a forecast.
 */
export interface Story {
    species: string;
    label: string;
    /** One caption per month, January first. */
    months: readonly string[];
}

export const STORIES: Readonly<Record<string, Story>> = {
    'humpback-au-east': {
        species: 'Megaptera novaeangliae',
        label: 'The humpback year',
        months: [
            'Humpbacks are feeding in Antarctic waters. The coast is quiet.',
            'Humpbacks are feeding in Antarctic waters. The coast is quiet.',
            'Humpbacks are feeding in Antarctic waters. The coast is quiet.',
            'The first humpbacks start the long swim north.',
            'Northbound humpbacks start passing New South Wales.',
            'The northern migration is in full swing past NSW and south-east Queensland.',
            'Humpbacks reach the warm water inside the Great Barrier Reef to calve.',
            'Calving season in the Whitsundays; the first whales turn south.',
            'Mothers and calves rest in Hervey Bay on the way south.',
            'Southbound: mothers and calves hug the coast past Moreton Bay.',
            'The last humpbacks head south to feed.',
            'Quiet season on the coast.',
        ],
    },
};
