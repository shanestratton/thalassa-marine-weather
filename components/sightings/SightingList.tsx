/**
 * The rows every Sightings list draws, grouped by day, and the life list.
 */
import React from 'react';
import { lifeList, type LifeListEntry } from '../../services/sightings/sightingService';
import { SIGHTING_GROUPS, type SightingGroup } from '../../services/sightings/types';
import { GroupChip, SightingIcon, type SightingIconName } from './SightingGlyphs';
import { dayLabel, formatDate, sightingTitle, type SightingItem } from './sightingsFormat';

const VIS_ICON: Record<string, SightingIconName> = {
    private: 'lock',
    crew: 'crew',
    public: 'globe',
    'public-feed': 'globe',
};
const VIS_WORD: Record<string, string> = {
    private: 'Private',
    crew: 'Crew',
    public: 'Public',
    'public-feed': 'Public',
};

export const SightingRow: React.FC<{
    item: SightingItem;
    byline: React.ReactNode;
    /** A second, quieter line (the public explainer, a sync state). */
    note?: React.ReactNode;
    /** A button beside the row (its own target, never nested in the row's). */
    action?: React.ReactNode;
    onOpen: (item: SightingItem) => void;
}> = ({ item, byline, note, action, onOpen }) => (
    <li className="flex items-center gap-2">
        <button
            type="button"
            onClick={() => onOpen(item)}
            className="flex min-h-[60px] min-w-0 flex-1 items-center gap-3 py-2 text-left"
            aria-label={[sightingTitle(item), byline, note]
                .filter((part): part is string => typeof part === 'string' && part.length > 0)
                .join('. ')}
        >
            <GroupChip group={item.group} />
            <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-extrabold leading-tight text-white">
                    {sightingTitle(item)}
                </span>
                <span className="block truncate text-[12.5px] tabular-nums sg-muted">{byline}</span>
                {note && <span className="block text-[12px] font-bold text-sky-300">{note}</span>}
            </span>
            <span className="flex shrink-0 items-center gap-1 sg-muted" title={VIS_WORD[item.visibility]}>
                <SightingIcon name={VIS_ICON[item.visibility] ?? 'globe'} className="h-4 w-4" />
                <span className="sr-only">{VIS_WORD[item.visibility]}</span>
            </span>
        </button>
        {action}
    </li>
);

/** Items under Today / Yesterday / "Sat 3 Oct" headings, newest first. */
export const DayGroupedList: React.FC<{
    items: SightingItem[];
    render: (item: SightingItem) => React.ReactNode;
}> = ({ items, render }) => {
    const days: Array<{ label: string; items: SightingItem[] }> = [];
    for (const item of items) {
        const label = dayLabel(item.eventDate);
        const last = days[days.length - 1];
        if (last && last.label === label) last.items.push(item);
        else days.push({ label, items: [item] });
    }
    return (
        <div className="space-y-3">
            {days.map((day) => (
                <section key={day.label} aria-label={day.label}>
                    <h2 className="mb-0.5 px-1 sg-eyebrow">{day.label}</h2>
                    <ul className="sg-card sg-divider px-3">{day.items.map(render)}</ul>
                </section>
            ))}
        </div>
    );
};

const LIFE_HEADINGS: Record<SightingGroup, string> = {
    whale: 'Whales',
    dolphin: 'Dolphins',
    dugong: 'Dugongs',
    turtle: 'Turtles',
    seabird: 'Seabirds',
    shark_ray: 'Sharks & rays',
    fish: 'Fish',
    other: 'Other',
};

export const LifeList: React.FC<{
    title: string;
    rows: ReadonlyArray<Pick<SightingItem, 'scientificName' | 'group' | 'eventDate' | 'vernacularName'>>;
    toggle?: React.ReactNode;
    /** Says when the list is not the whole story (offline: the last 30 days only). */
    note?: string;
}> = ({ title, rows, toggle, note }) => {
    const entries = lifeList(
        rows.map((r) => ({
            scientific_name: r.scientificName,
            taxon_group: r.group,
            event_date: r.eventDate,
            vernacular_name: r.vernacularName,
        })),
    );
    const first = entries[0];
    const newest = entries.reduce<LifeListEntry | null>(
        (best, e) => (!best || e.firstSeen > best.firstSeen ? e : best),
        null,
    );
    return (
        <div className="space-y-3" data-testid="life-list">
            <div className="sg-card relative overflow-hidden p-4">
                <div className="flex items-start justify-between gap-2">
                    <h2 className="sg-eyebrow">{title}</h2>
                    {toggle}
                </div>
                <div className="mt-1 text-[44px] font-black leading-none tabular-nums text-white">{entries.length}</div>
                {first ? (
                    <p className="mt-2 sg-note">
                        First: {first.vernacularName ?? first.scientificName}, {formatDate(first.firstSeen)}
                        {newest && newest !== first
                            ? ` · newest: ${newest.vernacularName ?? newest.scientificName}, ${dayLabel(newest.firstSeen).toLowerCase()}`
                            : ''}
                    </p>
                ) : (
                    <p className="mt-2 sg-note">
                        A species counts once you name it. Group-only sightings (“Whale”) wait until you refine them.
                    </p>
                )}
                {note && <p className="mt-1 sg-note">{note}</p>}
            </div>
            {SIGHTING_GROUPS.map((group) => {
                const inGroup = entries.filter((e) => e.group === group);
                if (inGroup.length === 0) return null;
                return (
                    <section key={group} aria-label={`${LIFE_HEADINGS[group]}, ${inGroup.length}`}>
                        <h2 className="mb-0.5 px-1 sg-eyebrow">
                            {LIFE_HEADINGS[group]} · {inGroup.length}
                        </h2>
                        <ul className="sg-card sg-divider px-3">
                            {inGroup.map((e) => (
                                <li key={e.scientificName} className="flex min-h-[56px] items-center gap-3 py-2">
                                    <GroupChip group={e.group} size="sm" />
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate text-[14.5px] font-extrabold text-white">
                                            {e.vernacularName ?? e.scientificName}
                                        </span>
                                        <span className="block truncate text-[12px] italic sg-muted">
                                            {e.scientificName}
                                        </span>
                                    </span>
                                    <span className="shrink-0 text-right">
                                        <span className="block text-[13px] font-bold tabular-nums text-white">
                                            {formatDate(e.firstSeen)}
                                        </span>
                                        <span className="block text-[11.5px] sg-muted">
                                            {e.sightings} {e.sightings === 1 ? 'sighting' : 'sightings'}
                                        </span>
                                    </span>
                                </li>
                            ))}
                        </ul>
                    </section>
                );
            })}
        </div>
    );
};
