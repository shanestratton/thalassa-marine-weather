/**
 * The way into Sightings from Scuttlebutt (Shane 2026-10-05: "we need to have
 * some kind of a thing is scuttlebutt where punters can track birds, turtles,
 * whales, even fish"). A card between Crew Chat and the channel list.
 *
 * Deliberately static: no counts, so the chat page never opens the sightings
 * store. It navigates with the UI store, so ChatPage itself is untouched. A
 * 'New' badge shows until Sightings is first opened on this phone.
 */
import React, { useState } from 'react';
import { useUIStore } from '../../stores/uiStore';
import { BinocularsGlyph } from './BinocularsGlyph';

/** Set by the Sightings page when it first opens; a per-phone nicety only. */
export const SIGHTINGS_SEEN_KEY = 'thalassa_sightings_seen_v1';

function seenBefore(): boolean {
    try {
        return localStorage.getItem(SIGHTINGS_SEEN_KEY) === '1';
    } catch {
        return true; // no storage: never nag
    }
}

export const SightingsEntryCard: React.FC = () => {
    const setPage = useUIStore((s) => s.setPage);
    const [isNew] = useState(() => !seenBefore());
    return (
        <button
            type="button"
            aria-label={isNew ? 'Sightings, new' : 'Sightings'}
            aria-describedby="sightings-entry-sub"
            onClick={() => setPage('sightings')}
            data-testid="sightings-entry"
            className="w-full group flex items-center gap-3.5 p-3.5 min-h-[56px] rounded-2xl bg-linear-to-r from-sky-500/10 to-sky-500/3 hover:from-sky-500/15 border border-sky-400/20 hover:border-sky-400/35 transition-all duration-200 active:scale-[0.98] mb-3"
        >
            <span
                aria-hidden="true"
                className="w-11 h-11 shrink-0 rounded-xl bg-linear-to-br from-sky-500/25 to-sky-600/10 border border-sky-400/30 flex items-center justify-center text-sky-300 group-hover:scale-110 transition-transform duration-200"
            >
                <BinocularsGlyph className="h-5 w-5" />
            </span>
            <span className="text-left flex-1 min-w-0">
                <span className="flex items-center gap-1.5">
                    <span className="text-lg font-semibold text-white/85 group-hover:text-white transition-colors">
                        Sightings
                    </span>
                    {isNew && (
                        <span
                            aria-hidden="true"
                            className="text-xs font-bold text-sky-300 bg-sky-500/15 px-1.5 py-0.5 rounded-full"
                        >
                            NEW
                        </span>
                    )}
                </span>
                <span id="sightings-entry-sub" className="block text-sm text-white/60 line-clamp-2 mt-0.5">
                    Whales, turtles, birds and fish your crew has seen
                </span>
            </span>
            <span
                aria-hidden="true"
                className="w-6 h-6 shrink-0 rounded-full bg-sky-500/10 flex items-center justify-center text-sky-300/60 text-xs"
            >
                ›
            </span>
        </button>
    );
};
