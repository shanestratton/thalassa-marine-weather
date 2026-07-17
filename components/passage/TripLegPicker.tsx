/**
 * TripLegPicker — the PLAN page's Trip box (Shane 2026-07-17: "we need to
 * get our LEGS functioning").
 *
 * Pick a trip (or any saved route — every route is a potential leg 1) and
 * the chain unrolls below it: each saved leg opens on the chart with one
 * tap, and the glowing last row — "⚓ Plot next leg from Woorim" — opens the
 * tracer with pin 1 pre-dropped and LOCKED at the previous leg's exact
 * final coordinates. Saving that plot names it "woorim - timbuktu (2nd
 * Leg)", stamps the chain, and retro-badges leg 1.
 *
 * Grouping is STRUCTURAL (SavedTrace.tripId — legs of one trip share leg
 * 1's id), with the "(Nth Leg)" name badge as the display fallback for
 * routes whose fields were shed by the cloud round-trip (the saved_routes
 * table doesn't carry the chain columns yet).
 */
import React from 'react';
import {
    loadSavedTraces,
    legBadgeOrdinal,
    stripLegBadge,
    nextLegSeed,
    ordinalLegLabel,
    type SavedTrace,
} from '../../services/routeTracer';
import { requestTracerOpen } from '../../services/deepLink';
import { triggerHaptic } from '../../utils/system';

interface UiTrip {
    key: string;
    label: string;
    legs: SavedTrace[]; // ordinal-sorted
}

const buildTrips = (): UiTrip[] => {
    const traces = loadSavedTraces();
    const groups = new Map<string, SavedTrace[]>();
    for (const t of traces) {
        const key = t.tripId ?? t.id;
        const g = groups.get(key);
        if (g) g.push(t);
        else groups.set(key, [t]);
    }
    return [...groups.entries()].map(([key, legs]) => {
        legs.sort(
            (a, b) => (a.legOrdinal ?? legBadgeOrdinal(a.name) ?? 1) - (b.legOrdinal ?? legBadgeOrdinal(b.name) ?? 1),
        );
        const base = stripLegBadge(legs[0].name);
        return { key, legs, label: legs.length > 1 ? `${base} … (${legs.length} legs)` : base };
    });
};

export const TripLegPicker: React.FC<{ onOpenChart: () => void }> = ({ onOpenChart }) => {
    const [trips, setTrips] = React.useState<UiTrip[]>(() => buildTrips());
    const [selectedKey, setSelectedKey] = React.useState('');
    // Saved routes land from the cloud merge after mount — refresh once the
    // punter actually opens the dropdown so the list is never stale.
    const refresh = (): void => setTrips(buildTrips());

    const selected = trips.find((t) => t.key === selectedKey) ?? null;
    const lastLeg = selected ? selected.legs[selected.legs.length - 1] : null;
    const seed = lastLeg ? nextLegSeed(lastLeg) : null;

    if (trips.length === 0) return null; // nothing saved yet — no empty furniture

    return (
        <div className="rounded-2xl border border-amber-500/20 bg-gradient-to-br from-amber-500/10 to-slate-900/40 p-3 shadow-[0_0_20px_rgba(245,158,11,0.08)]">
            <div className="mb-2 flex items-baseline justify-between">
                <span className="text-[11px] font-black uppercase tracking-widest text-amber-300">🧩 Trip · Legs</span>
                {selected && selected.legs.length > 1 && (
                    <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-amber-300">
                        {selected.legs.length} legs
                    </span>
                )}
            </div>
            <select
                value={selectedKey}
                onFocus={refresh}
                onChange={(e) => {
                    triggerHaptic('light');
                    setSelectedKey(e.target.value);
                }}
                aria-label="Pick a trip or route to continue"
                className="h-11 w-full rounded-xl border border-white/10 bg-slate-900/60 px-3 text-[13px] font-medium text-white [color-scheme:dark] focus:border-amber-500/50 focus:outline-none"
            >
                <option value="">Continue a trip or route…</option>
                {trips.map((t) => (
                    <option key={t.key} value={t.key}>
                        {t.label}
                    </option>
                ))}
            </select>
            {selected && (
                <div className="mt-2 space-y-1">
                    {selected.legs.map((leg, i) => (
                        <button
                            key={leg.id}
                            onClick={() => {
                                triggerHaptic('light');
                                requestTracerOpen({ kind: 'load-saved', id: leg.id });
                                onOpenChart();
                            }}
                            className="flex w-full items-center gap-2 rounded-xl border border-white/10 bg-slate-900/50 px-3 py-2 text-left active:scale-[0.99]"
                        >
                            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/10 text-[11px] font-black text-gray-300">
                                {i + 1}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-[13px] font-bold text-gray-200">
                                {leg.name}
                            </span>
                            <span className="shrink-0 text-[10px] font-bold text-gray-500">
                                {leg.points.length} pins
                            </span>
                        </button>
                    ))}
                    {seed && (
                        <button
                            onClick={() => {
                                triggerHaptic('medium');
                                requestTracerOpen({ kind: 'new-leg', fromId: lastLeg!.id });
                                onOpenChart();
                            }}
                            className="flex w-full items-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/15 px-3 py-2.5 text-left shadow-[0_0_14px_rgba(245,158,11,0.25)] active:scale-[0.99]"
                        >
                            <span className="text-base leading-none">⚓</span>
                            <span className="min-w-0 flex-1 truncate text-[13px] font-black text-amber-300">
                                Plot the {ordinalLegLabel(seed.ordinal).toLowerCase()} from {seed.fromName}
                            </span>
                            <span className="shrink-0 text-[11px] font-black text-amber-400">🔒→</span>
                        </button>
                    )}
                </div>
            )}
        </div>
    );
};
