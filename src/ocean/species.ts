import type { Group } from './oceanApi';

/**
 * The animal groups the public page shows, in chip order. Fish are not here
 * at all: catch spots never appear on this map, aggregated or otherwise.
 * `blurred` marks groups whose every species is threatened, so every sighting
 * of them is on the coarse 10 km grid.
 */
export interface GroupMeta {
    id: Group;
    label: string;
    one: string;
    colour: string;
    blurred: boolean;
    /** Shown on the map when the page opens. Seabird colony records would swamp it. */
    onByDefault: boolean;
}

export const GROUPS: readonly GroupMeta[] = [
    { id: 'whale', label: 'Whales', one: 'Whale', colour: '#a5b4fc', blurred: false, onByDefault: true },
    { id: 'dolphin', label: 'Dolphins', one: 'Dolphin', colour: '#5eead4', blurred: false, onByDefault: true },
    { id: 'dugong', label: 'Dugongs', one: 'Dugong', colour: '#fda4af', blurred: true, onByDefault: true },
    { id: 'turtle', label: 'Turtles', one: 'Turtle', colour: '#86efac', blurred: true, onByDefault: true },
    { id: 'seabird', label: 'Seabirds', one: 'Seabird', colour: '#fde68a', blurred: false, onByDefault: false },
    {
        id: 'shark_ray',
        label: 'Sharks & rays',
        one: 'Shark or ray',
        colour: '#f0abfc',
        blurred: false,
        onByDefault: true,
    },
    { id: 'other', label: 'Other', one: 'Animal', colour: '#cbd5e1', blurred: false, onByDefault: true },
];

export const groupMeta = (g: Group): GroupMeta => GROUPS.find((m) => m.id === g) ?? GROUPS[GROUPS.length - 1];

export const DEFAULT_GROUPS: readonly Group[] = GROUPS.filter((g) => g.onByDefault).map((g) => g.id);

/** 'Megaptera novaeangliae' → 'megaptera-novaeangliae', for /species/<slug>. */
export const speciesSlug = (sci: string): string =>
    sci
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
