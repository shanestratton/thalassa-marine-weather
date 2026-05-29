/**
 * LegPickerDropdown — Multi-leg / multi-trip passage planner helper.
 *
 * Every passage is Leg 1 by default. The skipper can open the leg
 * dropdown and pick "Leg 2 from <port>" to plan a continuation —
 * the Departure box auto-fills with the previous leg's arrival.
 * For Brisbane → Nouméa → Vanuatu → Fiji, this means typing each
 * port name only once.
 *
 * When more than one trip exists in the system (the active voyage
 * + any saved drafts), a Trip dropdown appears above the Leg
 * dropdown so the skipper can pick which chain they're extending.
 *
 * Trip sources:
 *   - The currently active voyage (its legs come from
 *     VoyageLegService — Cast Off / Arrive at Port writes to this).
 *   - Each draft voyage from getDraftVoyages() — treated as a
 *     single-leg trip whose Leg 1 is the saved (departure_port →
 *     destination_port) pair. Adding Leg 2 prefills departure with
 *     the trip's destination.
 *   - "New trip" — the always-present default; Leg 1 is empty,
 *     user types from scratch.
 *
 * Selecting a leg:
 *   - Leg 1 of an existing trip fills the Departure box with that
 *     trip's start port (lets the skipper re-plan with fresh
 *     weather without retyping).
 *   - Leg N (N > 1) fills Departure with the previous leg's
 *     arrival port AND clears the Destination box so the skipper
 *     types the next hop cleanly.
 *
 * Stays in sync with `thalassa:active-voyage-changed` plus a 5s
 * poll for the localStorage-backed leg state (VoyageLegService
 * doesn't fire its own event yet).
 */
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { triggerHaptic } from '../../utils/system';
import { getCachedActiveVoyage, getDraftVoyages, type Voyage } from '../../services/VoyageService';
import { getLegsForVoyage } from '../../services/VoyageLegService';
import type { PassageLeg } from '../../types/navigation';
import { VoyageCleanupSheet } from './VoyageCleanupSheet';
import { TripOverviewSheet } from './TripOverviewSheet';

interface LegPickerDropdownProps {
    /** Setter for the Departure ("From") input — wired into useVoyageForm.setOrigin */
    onSelectDeparture: (port: string) => void;
    /** Optional setter for the Destination ("To") input — wired into useVoyageForm.setDestination.
     *  When the user picks a leg with a known arrival we fill it; for new legs we clear so they
     *  type the next hop fresh. */
    onSelectDestination?: (port: string) => void;
    /** Optional setter for "is the departure field locked?". Fires `true` whenever the
     *  selected leg is part of a chain (Leg N>1 with a known departure inherited from the
     *  prior leg's arrival), and `false` for Leg 1 / "New trip" / ad-hoc starts. Locking
     *  the From input guarantees the next leg's departure_port matches the previous leg's
     *  destination_port byte-for-byte — which is what the chain matcher needs. Without
     *  this, typos like "Nouméa" vs "Noumea" silently break the chain and the multi-leg
     *  trip splits into two single-leg drafts. Optional so legacy consumers keep working. */
    onLockDeparture?: (locked: boolean) => void;
}

/** Internal model — a "leg" of a trip as the picker sees it. */
interface UiLeg {
    legNumber: number;
    departurePort: string;
    arrivalPort: string | null;
    /** completed = sailed and arrived; active = sailed, not yet arrived;
     *  draft = saved as a planned route, not yet cast off; future = the
     *  "+ Plan Leg N+1 from <last>" placeholder option. */
    status: 'completed' | 'active' | 'draft' | 'future';
}

/** Internal model — a "trip" as the picker sees it. */
interface UiTrip {
    id: string; // voyage.id, or 'new'
    name: string;
    /** Tag rendered next to the name in the dropdown. */
    badge: 'active' | 'draft' | 'new';
    legs: UiLeg[];
}

const NEW_TRIP_ID = 'new';

const NEW_TRIP: UiTrip = {
    id: NEW_TRIP_ID,
    name: 'New trip',
    badge: 'new',
    legs: [{ legNumber: 1, departurePort: '', arrivalPort: null, status: 'future' }],
};

function buildTripFromActiveVoyage(voyage: Voyage, legs: PassageLeg[]): UiTrip {
    const uiLegs: UiLeg[] = legs.map((l) => ({
        legNumber: l.leg_number,
        departurePort: l.departure_port,
        arrivalPort: l.arrival_port,
        status: l.status === 'completed' ? 'completed' : 'active',
    }));

    if (uiLegs.length > 0) {
        const last = uiLegs[uiLegs.length - 1];
        // Only offer "+ Plan Leg N+1" when we KNOW where the previous
        // leg ended. For an in-progress leg (arrival_port=null) the
        // skipper hasn't decided their stopover yet, so prefilling
        // departure with voyage.destination_port (the overall voyage
        // end) would be wrong — they'd want the next intermediate
        // stop, which the system doesn't know about. In that case we
        // skip the future-leg option and let them use "New trip"
        // for ad-hoc continuation planning.
        if (last.arrivalPort) {
            uiLegs.push({
                legNumber: last.legNumber + 1,
                departurePort: last.arrivalPort,
                arrivalPort: null,
                status: 'future',
            });
        }
    } else {
        // No legs yet (rare — Cast Off creates Leg 1; this covers the
        // pre-cast-off window or a manually-created active voyage row).
        uiLegs.push({
            legNumber: 1,
            departurePort: voyage.departure_port ?? '',
            arrivalPort: voyage.destination_port,
            status: 'draft',
        });
    }

    return {
        id: voyage.id,
        name: voyage.voyage_name,
        badge: 'active',
        legs: uiLegs,
    };
}

function buildTripFromDraftVoyage(voyage: Voyage): UiTrip {
    const dep = voyage.departure_port ?? '';
    const dst = voyage.destination_port;
    const legs: UiLeg[] = [{ legNumber: 1, departurePort: dep, arrivalPort: dst, status: 'draft' }];
    // Offer Leg 2 only when the draft has a known destination — that's
    // the port we'd prefill the next departure from.
    if (dst) {
        legs.push({ legNumber: 2, departurePort: dst, arrivalPort: null, status: 'future' });
    }
    return {
        id: voyage.id,
        name: voyage.voyage_name,
        badge: 'draft',
        legs,
    };
}

/** Lower-case + trim a port name for chain matching. */
function normPort(s: string | null | undefined): string {
    return (s ?? '').trim().toLowerCase();
}

/**
 * Group draft voyages into chains where each voyage's destination
 * matches the next voyage's departure (case-insensitive trim).
 *
 * For Brisbane → Nouméa → Vanuatu → Fiji saved as 3 drafts:
 *   - Brisbane → Nouméa
 *   - Nouméa → Vanuatu
 *   - Vanuatu → Fiji
 *
 * Returns a single chain `[draft1, draft2, draft3]` instead of three
 * standalone trips. Each chain renders as one multi-leg trip in the
 * picker so the user sees "Brisbane → Fiji (3 legs)" rather than
 * three disconnected drafts.
 *
 * Greedy linkage by name only — doesn't try to be smart about
 * timestamps or coordinates. If a draft's destination ambiguously
 * matches two later drafts' departures, the first match wins.
 */
function chainDrafts(drafts: Voyage[]): Voyage[][] {
    if (drafts.length === 0) return [];

    // Sort by created_at so chain endpoints are stable across loads.
    const remaining = [...drafts].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

    const chains: Voyage[][] = [];
    while (remaining.length > 0) {
        const head = remaining.shift()!;
        const chain: Voyage[] = [head];

        // Walk forward: keep finding the draft whose departure_port
        // matches the previous draft's destination_port.
        let extended = true;
        while (extended) {
            extended = false;
            const last = chain[chain.length - 1];
            const lastDest = normPort(last.destination_port);
            if (!lastDest) break;
            const idx = remaining.findIndex((d) => normPort(d.departure_port) === lastDest);
            if (idx >= 0) {
                chain.push(remaining.splice(idx, 1)[0]);
                extended = true;
            }
        }

        chains.push(chain);
    }
    return chains;
}

/**
 * Build a multi-leg UiTrip from a chain of draft voyages.
 * Single-draft chains fall through to the existing single-leg shape.
 */
function buildTripFromDraftChain(chain: Voyage[]): UiTrip {
    if (chain.length === 1) return buildTripFromDraftVoyage(chain[0]);

    const first = chain[0];
    const last = chain[chain.length - 1];
    const tripName = `${first.departure_port ?? '?'} → ${last.destination_port ?? '?'}`;

    const legs: UiLeg[] = chain.map((v, i) => ({
        legNumber: i + 1,
        departurePort: v.departure_port ?? '',
        arrivalPort: v.destination_port,
        status: 'draft' as const,
    }));

    // Offer the next leg in the chain ("Plan Leg N+1 from <last
    // arrival>") only when the chain's tail has a known destination.
    if (last.destination_port) {
        legs.push({
            legNumber: chain.length + 1,
            departurePort: last.destination_port,
            arrivalPort: null,
            status: 'future',
        });
    }

    return {
        // Use the first draft's id as the trip id — stable across
        // reloads, the persisted selection survives chain growth.
        id: first.id,
        name: tripName,
        badge: 'draft',
        legs,
    };
}

const BADGE_STYLE: Record<UiTrip['badge'], string> = {
    active: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/25',
    draft: 'bg-sky-500/10 text-sky-300 border-sky-500/20',
    new: 'bg-white/[0.05] text-gray-300 border-white/10',
};

const BADGE_LABEL: Record<UiTrip['badge'], string> = {
    active: 'Active',
    draft: 'Draft',
    new: 'New',
};

const LEG_STATUS_GLYPH: Record<UiLeg['status'], string> = {
    completed: '✓',
    active: '●',
    draft: '○',
    future: '+',
};

const LEG_STATUS_LABEL: Record<UiLeg['status'], string> = {
    completed: 'Sailed',
    active: 'Underway',
    draft: 'Planned',
    future: 'New leg',
};

export const LegPickerDropdown: React.FC<LegPickerDropdownProps> = ({
    onSelectDeparture,
    onSelectDestination,
    onLockDeparture,
}) => {
    const [trips, setTrips] = useState<UiTrip[]>([NEW_TRIP]);
    const [tripId, setTripId] = useState<string>(NEW_TRIP_ID);
    const [legNumber, setLegNumber] = useState<number>(1);
    const [tripOpen, setTripOpen] = useState(false);
    const [legOpen, setLegOpen] = useState(false);
    /** "Manage saved trips" sheet — admin-style list of every voyage
     *  row + every saved planned route, each with a delete button.
     *  Necessary because the normal drafts dropdown filters to
     *  status='planning' so a test/orphan trip in another status
     *  becomes invisible without this surface. */
    const [cleanupOpen, setCleanupOpen] = useState(false);
    /** "Trip overview" sheet — whole-trip view + PDF export. */
    const [overviewOpen, setOverviewOpen] = useState(false);
    /** Chains keyed by their UiTrip id (= first draft's UUID, OR
     *  the active voyage's id) so the overview sheet can pull the
     *  ORDERED Voyage[] back out when the user opens it. The picker's
     *  UiTrip model holds the display shape; the cached chains hold
     *  the underlying voyage rows. Refreshed on every refresh(). */
    const [chainsByTripId, setChainsByTripId] = useState<Map<string, Voyage[]>>(new Map());

    /** Load trips: active voyage + drafts (chained) + always-present "New trip".
     *
     *  Drafts are chained: Brisbane → Nouméa, Nouméa → Vanuatu, Vanuatu →
     *  Fiji collapses into ONE multi-leg trip "Brisbane → Fiji" with three
     *  legs, instead of three disconnected drafts. The user just plans
     *  legs sequentially — the picker discovers the trip structure on
     *  next load by matching destinations to next-leg departures. No
     *  schema migration required.
     */
    const refresh = useCallback(async () => {
        const built: UiTrip[] = [NEW_TRIP];
        const active = getCachedActiveVoyage();
        const seenIds = new Set<string>();
        const chainMap = new Map<string, Voyage[]>();

        if (active) {
            const legs = getLegsForVoyage(active.id);
            built.push(buildTripFromActiveVoyage(active, legs));
            // Active voyage is its own chain — single voyage entry.
            // The trip overview will resolve legs from VoyageLegService
            // separately when the active trip is selected; for now
            // record the voyage row so the overview has something.
            chainMap.set(active.id, [active]);
            seenIds.add(active.id);
        }

        try {
            const drafts = await getDraftVoyages();
            const remainingDrafts = drafts.filter((d) => !seenIds.has(d.id));
            const chains = chainDrafts(remainingDrafts);
            for (const chain of chains) {
                built.push(buildTripFromDraftChain(chain));
                // The chain's id (per buildTripFromDraftChain) is the
                // first draft's UUID — same key the trip dropdown uses.
                chainMap.set(chain[0].id, chain);
                for (const v of chain) seenIds.add(v.id);
            }
        } catch {
            /* offline — show what we have */
        }

        setTrips(built);
        setChainsByTripId(chainMap);
    }, []);

    useEffect(() => {
        refresh();
        const handler = () => refresh();
        window.addEventListener('thalassa:active-voyage-changed', handler);
        // Passage-plan-saved fires immediately after a Calculate + Save,
        // when a new draft voyage row has just been created. Without
        // this listener the picker would not pick up the new leg until
        // the 5 s polling interval fires — long enough that the user
        // assumes they're stuck and can't plan another leg. Wired in
        // 2026-05-19 alongside the auto-advance effect below.
        window.addEventListener('thalassa:passage-plan-saved', handler);
        // VoyageLegService is localStorage-backed and silent — poll
        // every 5s so a Depart-Next-Leg / Arrive-at-Port action in
        // CastOffPanel reflects without a route planner remount.
        const t = setInterval(refresh, 5_000);
        return () => {
            window.removeEventListener('thalassa:active-voyage-changed', handler);
            window.removeEventListener('thalassa:passage-plan-saved', handler);
            clearInterval(t);
        };
    }, [refresh]);

    // If the currently selected trip disappears (voyage ended, draft
    // deleted), fall back to "New trip" so the leg dropdown stays sane.
    useEffect(() => {
        if (!trips.find((t) => t.id === tripId)) {
            setTripId(NEW_TRIP_ID);
            setLegNumber(1);
        }
    }, [trips, tripId]);

    const selectedTrip = useMemo(() => trips.find((t) => t.id === tripId) ?? NEW_TRIP, [trips, tripId]);
    const selectedLeg = useMemo(
        () => selectedTrip.legs.find((l) => l.legNumber === legNumber) ?? selectedTrip.legs[0] ?? NEW_TRIP.legs[0],
        [selectedTrip, legNumber],
    );

    /** Apply a (trip, leg) selection to the form inputs.
     *
     *  Pure form-filler — NEVER auto-fires the routing engine. The
     *  user explicitly slides the "Calculate Route" gesture when
     *  they're ready. An earlier version auto-calculated whenever a
     *  picked leg had both endpoints known, which was helpful for
     *  re-planning a saved leg with fresh weather but made the
     *  multi-leg planning flow unusable: tapping the trip dropdown
     *  immediately yanked the user to the map mid-decision before
     *  they could see / pick which leg they actually wanted.
     *
     *  Now: pick a trip → form fills with Leg 1's defaults so the
     *  user can see what they're working with. Open the leg dropdown
     *  → pick Leg 2/3/… → From flips to the previous leg's arrival,
     *  To clears (or fills with the leg's known arrival for
     *  re-planning). User reviews, edits, then calculates manually.
     */
    const apply = useCallback(
        (_trip: UiTrip, leg: UiLeg) => {
            triggerHaptic('light');
            // Always fill From with the leg's departure (empty for "New
            // trip / Leg 1" — that just clears the departure, which is
            // what the user expects when starting fresh).
            onSelectDeparture(leg.departurePort);

            // For Leg N+1 (future), clear Destination so the user types
            // the next hop. For completed/draft legs we fill with the
            // known arrival so the form mirrors the saved route — the
            // user can edit either field before calculating.
            if (onSelectDestination) {
                if (leg.status === 'future') {
                    onSelectDestination('');
                } else if (leg.arrivalPort) {
                    onSelectDestination(leg.arrivalPort);
                }
            }

            // Lock the From field whenever this leg is a continuation
            // of an earlier leg (legNumber > 1 with a known departure
            // inherited from the chain). That removes the only failure
            // mode for the destination↔departure chain matcher: typos.
            // Leg 1 / "New trip" / orphaned drafts stay editable so
            // ad-hoc trip starts still work.
            if (onLockDeparture) {
                onLockDeparture(leg.legNumber > 1 && leg.departurePort.trim().length > 0);
            }
        },
        [onSelectDeparture, onSelectDestination, onLockDeparture],
    );

    // ── Auto-advance to the next future leg after save ──
    // Without this, multi-leg planning felt like it caps at 2 legs:
    //   1. User picks future Leg N (status='future') in the dropdown.
    //   2. Calculates + Saves → a new draft voyage row is created.
    //   3. refresh() rebuilds the chain → Leg N is now status='draft'
    //      and a new future leg N+1 has been appended.
    //   4. BUT legNumber is still N, so selectedLeg resolves to the
    //      just-saved draft. The user sees the form filled with Leg
    //      N's saved values, with no obvious cue that Leg N+1 exists.
    //      Many users assume the planner is "done" at this point.
    //
    // Fix: when the previously-selected leg transitions from 'future'
    // to 'draft' AND the new chain has a future leg with a higher
    // legNumber, jump to it automatically. The form refills via apply()
    // so the user can immediately type the next destination.
    //
    // Scoped tightly: only fires on the SAME tripId, and only when the
    // exact "future → draft" transition is detected. Doesn't hijack a
    // manual selection of an older draft leg for re-editing.
    const prevTripRef = useRef<UiTrip | null>(null);
    useEffect(() => {
        const prev = prevTripRef.current;
        prevTripRef.current = selectedTrip;
        if (!prev || prev.id !== selectedTrip.id) return;
        const prevLeg = prev.legs.find((l) => l.legNumber === legNumber);
        if (prevLeg?.status !== 'future') return;
        const newLegSameNumber = selectedTrip.legs.find((l) => l.legNumber === legNumber);
        if (newLegSameNumber?.status !== 'draft') return; // hasn't transitioned yet
        const nextFuture = selectedTrip.legs.find((l) => l.status === 'future' && l.legNumber > legNumber);
        if (!nextFuture) return;
        setLegNumber(nextFuture.legNumber);
        apply(selectedTrip, nextFuture);
    }, [selectedTrip, legNumber, apply]);

    /**
     *  Pick the "default leg" to surface when a trip is selected.
     *
     *  Mental model: the user picks a trip because they want to plan
     *  *something* on it. The most useful default is the leg they
     *  haven't planned yet (the "future" leg) — that way the form is
     *  pre-filled with the correct From port and they can immediately
     *  type the next destination. Falls back through:
     *
     *    1. New Trip → Leg 1 (always)
     *    2. Active voyage → the leg currently underway, OR the next
     *       future leg if all existing legs are completed
     *    3. Draft chain → the future leg "+ Plan Leg N+1 from <last
     *       arrival>" — what the user came here to plan
     *    4. No future leg available → Leg 1 (re-plan from scratch)
     */
    const defaultLegFor = (trip: UiTrip): UiLeg => {
        if (trip.id === NEW_TRIP_ID) return trip.legs[0];

        // Prefer an active leg (in-progress sail) over a future stub.
        const activeLeg = trip.legs.find((l) => l.status === 'active');
        if (activeLeg) return activeLeg;

        // Then prefer the future leg (next to plan).
        const futureLeg = trip.legs.find((l) => l.status === 'future');
        if (futureLeg) return futureLeg;

        // Otherwise the last existing leg (re-plan).
        return trip.legs[trip.legs.length - 1] ?? trip.legs[0];
    };

    const pickTrip = useCallback(
        (trip: UiTrip) => {
            const defaultLeg = defaultLegFor(trip);
            setTripId(trip.id);
            setLegNumber(defaultLeg.legNumber);
            setTripOpen(false);
            // Leg dropdown stays closed — the leg label shows the
            // current selection. User opens it themselves only to
            // switch to a different leg.
            setLegOpen(false);
            apply(trip, defaultLeg);
        },
        [apply],
    );

    const pickLeg = useCallback(
        (leg: UiLeg) => {
            setLegNumber(leg.legNumber);
            setLegOpen(false);
            apply(selectedTrip, leg);
        },
        [apply, selectedTrip],
    );

    // Trip picker is suppressed when there's only one option (the
    // always-present "New trip"). Saves vertical space for users who
    // aren't running multi-leg passages.
    const showTripPicker = trips.length > 1;

    const tripBadgeStyle = BADGE_STYLE[selectedTrip.badge];
    const tripBadgeLabel = BADGE_LABEL[selectedTrip.badge];

    const legStatusGlyph = LEG_STATUS_GLYPH[selectedLeg.status];
    const legStatusLabel = LEG_STATUS_LABEL[selectedLeg.status];

    const legSummary =
        selectedLeg.status === 'future'
            ? selectedLeg.departurePort
                ? `Leg ${selectedLeg.legNumber} — from ${selectedLeg.departurePort}`
                : `Leg ${selectedLeg.legNumber}`
            : `Leg ${selectedLeg.legNumber} — ${selectedLeg.departurePort || '?'}${
                  selectedLeg.arrivalPort ? ` → ${selectedLeg.arrivalPort}` : ''
              }`;

    return (
        <div className="space-y-2">
            {/* Trip picker — only when 2+ trips exist */}
            {showTripPicker && (
                <div className="relative">
                    <button
                        type="button"
                        onClick={() => {
                            setTripOpen((v) => !v);
                            setLegOpen(false);
                            triggerHaptic('light');
                        }}
                        className="w-full h-11 bg-amber-500/[0.04] border border-amber-500/20 hover:border-amber-500/40 rounded-xl px-4 text-sm text-amber-100 font-medium outline-none transition-all flex items-center justify-between gap-2"
                        aria-haspopup="listbox"
                        aria-expanded={tripOpen}
                    >
                        <div className="flex items-center gap-2 min-w-0">
                            <span className="text-[10px] font-black tracking-[0.18em] uppercase text-amber-400/80 shrink-0">
                                Trip
                            </span>
                            <span className="truncate text-left flex-1">{selectedTrip.name}</span>
                            <span
                                className={`shrink-0 px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-widest border ${tripBadgeStyle}`}
                            >
                                {tripBadgeLabel}
                            </span>
                        </div>
                        <svg
                            className={`w-4 h-4 shrink-0 transition-transform ${tripOpen ? 'rotate-180' : ''}`}
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={2}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                        >
                            <path d="M6 9l6 6 6-6" />
                        </svg>
                    </button>

                    {tripOpen && (
                        <div
                            role="listbox"
                            className="absolute left-0 right-0 top-full mt-1 z-30 bg-[#0a0e14] border border-amber-500/20 rounded-xl shadow-xl shadow-black/40 overflow-hidden max-h-64 overflow-y-auto"
                        >
                            {trips.map((t) => (
                                <button
                                    key={t.id}
                                    type="button"
                                    role="option"
                                    aria-selected={tripId === t.id}
                                    onClick={() => pickTrip(t)}
                                    className={`w-full px-4 py-2.5 text-left text-sm border-b border-white/[0.04] last:border-b-0 transition-colors flex items-center gap-2 ${
                                        tripId === t.id
                                            ? 'bg-amber-500/[0.08] text-amber-200'
                                            : 'text-white hover:bg-white/[0.05]'
                                    }`}
                                >
                                    <span className="truncate flex-1">{t.name}</span>
                                    <span
                                        className={`shrink-0 px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-widest border ${BADGE_STYLE[t.badge]}`}
                                    >
                                        {BADGE_LABEL[t.badge]}
                                    </span>
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* Leg picker — always visible */}
            <div className="relative">
                <button
                    type="button"
                    onClick={() => {
                        setLegOpen((v) => !v);
                        setTripOpen(false);
                        triggerHaptic('light');
                    }}
                    className="w-full h-11 bg-amber-500/[0.06] border border-amber-500/20 hover:border-amber-500/40 rounded-xl px-4 text-sm text-amber-200 font-medium outline-none transition-all flex items-center justify-between gap-2"
                    aria-haspopup="listbox"
                    aria-expanded={legOpen}
                >
                    <div className="flex items-center gap-2 min-w-0">
                        <span className="text-[10px] font-black tracking-[0.18em] uppercase text-amber-400/80 shrink-0">
                            Leg
                        </span>
                        <span className="truncate text-left flex-1">{legSummary}</span>
                        <span
                            className="shrink-0 text-[10px] text-amber-400/70"
                            title={legStatusLabel}
                            aria-label={legStatusLabel}
                        >
                            {legStatusGlyph}
                        </span>
                    </div>
                    <svg
                        className={`w-4 h-4 shrink-0 transition-transform ${legOpen ? 'rotate-180' : ''}`}
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                    >
                        <path d="M6 9l6 6 6-6" />
                    </svg>
                </button>

                {legOpen && (
                    <div
                        role="listbox"
                        className="absolute left-0 right-0 top-full mt-1 z-30 bg-[#0a0e14] border border-amber-500/20 rounded-xl shadow-xl shadow-black/40 overflow-hidden max-h-72 overflow-y-auto"
                    >
                        {selectedTrip.legs.map((l) => {
                            const summary =
                                l.status === 'future'
                                    ? l.departurePort
                                        ? `Plan Leg ${l.legNumber} from ${l.departurePort}`
                                        : `Leg ${l.legNumber} — New trip`
                                    : `Leg ${l.legNumber} — ${l.departurePort}${l.arrivalPort ? ` → ${l.arrivalPort}` : ''}`;
                            const isSelected = legNumber === l.legNumber;
                            const isFuture = l.status === 'future';
                            return (
                                <button
                                    key={l.legNumber}
                                    type="button"
                                    role="option"
                                    aria-selected={isSelected}
                                    onClick={() => pickLeg(l)}
                                    className={`w-full px-4 py-2.5 text-left text-sm border-b border-white/[0.04] last:border-b-0 transition-colors flex items-center gap-2 ${
                                        isSelected
                                            ? 'bg-amber-500/[0.08] text-amber-200'
                                            : isFuture
                                              ? 'text-amber-300 hover:bg-amber-500/[0.06] font-bold'
                                              : 'text-white hover:bg-white/[0.05]'
                                    }`}
                                >
                                    <span className="truncate flex-1">{summary}</span>
                                    <span
                                        className="shrink-0 text-[11px] text-amber-400/70 w-4 text-center"
                                        title={LEG_STATUS_LABEL[l.status]}
                                        aria-label={LEG_STATUS_LABEL[l.status]}
                                    >
                                        {LEG_STATUS_GLYPH[l.status]}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* Footer — Trip overview is the primary user-facing
                action when a real trip is picked (full-width sky CTA
                with proper hit area). Manage saved trips stays as a
                small admin-style text link below — same data surface
                the user reaches when something's gone wrong, doesn't
                need the same visual weight. */}
            {tripId !== NEW_TRIP_ID && (chainsByTripId.get(tripId)?.length ?? 0) > 0 && (
                <button
                    type="button"
                    onClick={() => {
                        setOverviewOpen(true);
                        triggerHaptic('light');
                    }}
                    className="w-full py-3 rounded-xl bg-sky-500/15 border border-sky-500/30 hover:bg-sky-500/25 active:scale-[0.98] transition-all text-sky-200 text-sm font-bold tracking-wide flex items-center justify-center gap-2"
                >
                    <span className="text-base">📋</span>
                    <span>View whole trip + export PDF</span>
                </button>
            )}

            <div className="text-center">
                <button
                    type="button"
                    onClick={() => {
                        setCleanupOpen(true);
                        triggerHaptic('light');
                    }}
                    className="text-[11px] text-gray-500 hover:text-amber-300 transition-colors px-2 py-1"
                >
                    ⚙ Manage saved trips
                </button>
            </div>

            <VoyageCleanupSheet isOpen={cleanupOpen} onClose={() => setCleanupOpen(false)} onChanged={refresh} />

            <TripOverviewSheet
                isOpen={overviewOpen}
                onClose={() => setOverviewOpen(false)}
                legs={chainsByTripId.get(tripId) ?? []}
                tripName={selectedTrip.name}
            />
        </div>
    );
};
