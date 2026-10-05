/**
 * "Which species?" — the refine step, never forced: a sighting is complete at
 * group level, and the species can be added now or later.
 *
 * Searches common names, other names and Latin names across all groups (a tap
 * on Whale may have been a whale shark). Recent picks first. Threatened
 * species carry an outline badge: their public copies go on the 8 km grid.
 *
 * Species only ever come from the bundled catalogue (no free text), so the
 * public text never needs moderation; the server copies the names from its
 * own table.
 *
 * Keyboard: a centred dialog (SightingsSheet) that lifts above the keyboard,
 * with the search field at the top of its card, never under the keyboard.
 * tests/KeyboardSafeSheets.test.ts lists this file.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
    loadCatalogue,
    searchSpecies,
    type CatalogueSpecies,
    type SightingCatalogue,
} from '../../services/sightings/catalogue';
import { getSightingMeta, putSightingMeta } from '../../services/sightings/sightingStore';
import { SIGHTING_GROUPS, SIGHTING_GROUP_LABELS, type SightingGroup } from '../../services/sightings/types';
import { getAuthIdentityScope } from '../../services/authIdentityScope';
import { SightingsSheet } from './SightingsSheet';
import { GroupChip, SightingIcon } from './SightingGlyphs';

const RECENTS = 'recent-species';
const RECENTS_MAX = 6;

export async function rememberRecentSpecies(scientificName: string): Promise<void> {
    const userId = getAuthIdentityScope().userId;
    const now = (await getSightingMeta<string[]>(userId, RECENTS)) ?? [];
    await putSightingMeta(
        userId,
        RECENTS,
        [scientificName, ...now.filter((n) => n !== scientificName)].slice(0, RECENTS_MAX),
    );
}

const GROUP_PLURAL: Record<SightingGroup, string> = {
    whale: 'Whales',
    dolphin: 'Dolphins',
    dugong: 'Dugong',
    turtle: 'Turtles',
    seabird: 'Seabirds',
    shark_ray: 'Sharks & rays',
    fish: 'Fish',
    other: 'Other',
};

const SpeciesRow: React.FC<{ species: CatalogueSpecies; selected: boolean; onPick: () => void }> = ({
    species,
    selected,
    onPick,
}) => (
    <li>
        <button
            type="button"
            onClick={onPick}
            aria-pressed={selected}
            aria-label={`${species.vernacularName}, ${species.scientificName}${species.sensitive ? ', threatened' : ''}`}
            className="flex min-h-[56px] w-full items-center gap-3 py-2 text-left"
        >
            <GroupChip group={species.group} size="sm" />
            <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-bold leading-tight text-white">{species.vernacularName}</span>
                <span className="block truncate text-[12.5px] italic sg-muted">{species.scientificName}</span>
            </span>
            {species.sensitive && (
                <span className="shrink-0 rounded-full border border-white/30 px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-white/70">
                    Threatened
                </span>
            )}
            {selected && (
                <span className="shrink-0 text-sky-300">
                    <SightingIcon name="check" className="h-5 w-5" />
                </span>
            )}
        </button>
    </li>
);

export interface SpeciesPickerProps {
    group: SightingGroup;
    selected: string | null;
    onPick: (species: CatalogueSpecies | null) => void;
    onClose: () => void;
    /** Test seam. */
    catalogueLoader?: () => Promise<SightingCatalogue | null>;
}

export const SpeciesPicker: React.FC<SpeciesPickerProps> = ({
    group,
    selected,
    onPick,
    onClose,
    catalogueLoader = loadCatalogue,
}) => {
    const [catalogue, setCatalogue] = useState<SightingCatalogue | null | undefined>(undefined);
    const [query, setQuery] = useState('');
    const [filter, setFilter] = useState<SightingGroup | null>(group);
    const [recents, setRecents] = useState<string[]>([]);

    useEffect(() => {
        let live = true;
        void catalogueLoader().then((c) => live && setCatalogue(c));
        void getSightingMeta<string[]>(getAuthIdentityScope().userId, RECENTS).then((r) => live && setRecents(r ?? []));
        return () => {
            live = false;
        };
    }, [catalogueLoader]);

    const results = useMemo(() => {
        if (!catalogue) return [];
        if (query.trim()) return searchSpecies(catalogue, query, { group, limit: 60 });
        return catalogue.species.filter((s) => !filter || s.group === filter);
    }, [catalogue, query, filter, group]);

    const recentSpecies = useMemo(
        () =>
            catalogue && !query.trim()
                ? recents
                      .map((n) => catalogue.byScientificName.get(n))
                      .filter((s): s is CatalogueSpecies => !!s && (!filter || s.group === filter))
                : [],
        [catalogue, recents, query, filter],
    );

    const pick = (species: CatalogueSpecies) => {
        void rememberRecentSpecies(species.scientificName);
        onPick(species);
    };

    const total = catalogue?.species.length ?? 0;
    const heading = query.trim()
        ? `${results.length} ${results.length === 1 ? 'match' : 'matches'}`
        : filter
          ? `${GROUP_PLURAL[filter]} · ${results.length}`
          : `All species · ${results.length}`;

    return (
        <SightingsSheet
            title="Which species?"
            onClose={onClose}
            closeLabel="Close species list"
            testId="species-picker"
            footer={
                <div>
                    <button
                        type="button"
                        onClick={() => onPick(null)}
                        className="sg-toggle flex min-h-[48px] w-full items-center justify-center rounded-2xl px-4 text-[14px] font-extrabold"
                    >
                        Not sure: keep it as {SIGHTING_GROUP_LABELS[group]}
                    </button>
                    <p className="mt-2 text-[11.5px] leading-snug sg-muted">
                        Threatened species are blurred to about 8 km on the public feed. You can refine it later.
                    </p>
                </div>
            }
        >
            <label className="relative block">
                <span className="sr-only">Search species</span>
                <span className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 sg-muted">
                    <SightingIcon name="search" className="h-[18px] w-[18px]" />
                </span>
                <input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={total ? `Search ${total} species or a Latin name` : 'Search species'}
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                    enterKeyHint="search"
                    className="sg-input min-h-[48px] w-full rounded-[14px] py-3 pr-3 pl-10 text-[15px] text-white"
                />
            </label>
            {!query.trim() && (
                <div
                    role="group"
                    aria-label="Show a group"
                    className="-mx-1 mt-2.5 flex gap-1.5 overflow-x-auto px-1 pb-1"
                    style={{ scrollbarWidth: 'none' }}
                >
                    {[null, ...SIGHTING_GROUPS].map((g) => (
                        <button
                            key={g ?? 'all'}
                            type="button"
                            aria-pressed={filter === g}
                            onClick={() => setFilter(g)}
                            className="sg-toggle sg-pill"
                        >
                            {g ? SIGHTING_GROUP_LABELS[g] : 'All'}
                        </button>
                    ))}
                </div>
            )}
            {catalogue === undefined ? (
                <p className="py-6 text-center text-sm sg-muted" role="status">
                    Opening the species list…
                </p>
            ) : catalogue === null ? (
                <p className="py-6 text-center text-sm sg-muted" role="status">
                    The species list couldn’t be opened. The sighting is saved as {SIGHTING_GROUP_LABELS[group]}; you
                    can refine it later.
                </p>
            ) : (
                <>
                    {recentSpecies.length > 0 && (
                        <>
                            <h3 className="mt-3 sg-eyebrow">Recent</h3>
                            <ul className="sg-divider">
                                {recentSpecies.map((s) => (
                                    <SpeciesRow
                                        key={`recent-${s.scientificName}`}
                                        species={s}
                                        selected={selected === s.scientificName}
                                        onPick={() => pick(s)}
                                    />
                                ))}
                            </ul>
                        </>
                    )}
                    <h3 className="mt-3 sg-eyebrow" aria-live="polite">
                        {heading}
                    </h3>
                    {results.length === 0 ? (
                        <p className="py-4 text-sm sg-muted">
                            Nothing by that name in this region’s list yet. Keep it as {SIGHTING_GROUP_LABELS[group]}{' '}
                            and add a note.
                        </p>
                    ) : (
                        <ul className="sg-divider">
                            {results.map((s) => (
                                <SpeciesRow
                                    key={s.scientificName}
                                    species={s}
                                    selected={selected === s.scientificName}
                                    onPick={() => pick(s)}
                                />
                            ))}
                        </ul>
                    )}
                </>
            )}
        </SightingsSheet>
    );
};
