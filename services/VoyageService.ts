/**
 * VoyageService — Passage state management.
 *
 * Tracks active voyages. When a voyage is active:
 *  - Report Position UI is prioritised
 *  - Weather Master lock is enforced
 *  - P2P sync heartbeat runs
 */

import { supabase } from './supabase';
import { startLeg, closeLeg, getActiveLeg, deleteLegsForVoyage } from './VoyageLegService';

// ── Types ──────────────────────────────────────────────────────────────────

export type VoyageStatus = 'planning' | 'active' | 'completed' | 'aborted';

export interface Voyage {
    id: string;
    user_id: string;
    vessel_id: string | null;
    voyage_name: string;
    departure_port: string | null;
    destination_port: string | null;
    departure_time: string | null;
    eta: string | null;
    crew_count: number;
    status: VoyageStatus;
    weather_master_id: string | null;
    notes: string | null;
    created_at: string;
    updated_at: string;
}

// ── Local state (for offline access) ──────────────────────────────────────

const ACTIVE_VOYAGE_KEY = 'thalassa_active_voyage';

function cacheVoyage(v: Voyage | null): void {
    try {
        if (v) localStorage.setItem(ACTIVE_VOYAGE_KEY, JSON.stringify(v));
        else localStorage.removeItem(ACTIVE_VOYAGE_KEY);
    } catch {
        /* full */
    }
    // Notify any listening UI (SystemStatusButton, hero card, etc)
    // that the active voyage has changed. They subscribe synchronously
    // via getCachedActiveVoyage() — no network round-trip.
    try {
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('thalassa:active-voyage-changed', { detail: { voyage: v } }));
        }
    } catch {
        /* SSR / older browser — non-critical */
    }
}

/** Get cached active voyage (offline-safe) */
export function getCachedActiveVoyage(): Voyage | null {
    try {
        const raw = localStorage.getItem(ACTIVE_VOYAGE_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

// ── CRUD ────────────────────────────────────────────────────────────────

/**
 * Create a new voyage (starts in 'planning' status).
 *
 * Optional departure_time / eta let the caller seed the dates at
 * creation — used by PassagePlanSave so a route saved with a typed
 * departureDate doesn't lose it when re-opened in Passage Planning.
 */
export async function createVoyage(
    data: Pick<Voyage, 'voyage_name' | 'departure_port' | 'destination_port' | 'crew_count'> & {
        vessel_id?: string;
        departure_time?: string | null;
        eta?: string | null;
    },
): Promise<{ voyage: Voyage | null; error?: string }> {
    if (!supabase) return { voyage: null, error: 'Offline — no Supabase connection' };

    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { voyage: null, error: 'Sign in required to create a voyage' };

    const { data: voyage, error } = await supabase
        .from('voyages')
        .insert({
            ...data,
            user_id: user.id,
            weather_master_id: user.id, // Skipper is default master
            status: 'planning',
        })
        .select()
        .single();

    if (error) {
        console.error('[VoyageService] createVoyage failed:', error.message, error.details, error.hint, error.code);
        return { voyage: null, error: error.message };
    }
    return { voyage: voyage as Voyage };
}

/** Editable fields on a draft voyage */
export type VoyageUpdate = Partial<
    Pick<
        Voyage,
        'voyage_name' | 'departure_port' | 'destination_port' | 'departure_time' | 'eta' | 'crew_count' | 'notes'
    >
>;

/** Update a draft voyage (planning status only) */
export async function updateVoyage(
    voyageId: string,
    data: VoyageUpdate,
): Promise<{ voyage: Voyage | null; error?: string }> {
    if (!supabase) return { voyage: null, error: 'Offline — no Supabase connection' };

    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { voyage: null, error: 'Sign in required' };

    const { data: voyage, error } = await supabase
        .from('voyages')
        .update({
            ...data,
            updated_at: new Date().toISOString(),
        })
        .eq('id', voyageId)
        .eq('user_id', user.id)
        .select()
        .single();

    if (error) {
        console.error('[VoyageService] updateVoyage failed:', error.message);
        return { voyage: null, error: error.message };
    }

    const updated = voyage as Voyage;
    cacheVoyage(updated);
    return { voyage: updated };
}

/** Start a passage (set status to 'active') */
export async function startVoyage(voyageId: string): Promise<Voyage | null> {
    if (!supabase) return null;

    const { data, error } = await supabase
        .from('voyages')
        .update({
            status: 'active',
            departure_time: new Date().toISOString(),
        })
        .eq('id', voyageId)
        .select()
        .single();

    if (error) return null;
    const voyage = data as Voyage;
    cacheVoyage(voyage);
    return voyage;
}

// Earlier iterations of this file had a getDraftVoyagesWithLogbookEntries()
// fetcher that tried to filter or auto-heal the voyages-table to mirror the
// logbook. That created drift in both directions and caused the dropdown
// to flicker between empty and showing stale data. Removed in favour of a
// simpler model in CrewManagement.tsx: read the dropdown directly from
// fetchRoutesAndTracks() and find-or-create voyages-table rows only at
// select-time. The voyages table is no longer the source of truth for
// "what passages exist" — the logbook is.
//
// `getDraftVoyages()` (below) is still used by other consumers
// (GalleyCard, ChannelList, CastOffPanel) that want the raw drafts list.

/**
 * Delete draft (planning) voyages whose `voyage_name` matches `name`
 * AND whose `created_at` falls on `dayKey` (YYYY-MM-DD).
 *
 * Day-level matching is intentional: a planned_* shiplog voyage and
 * its auto-created voyages-table row are spawned in the same critical
 * section in PassagePlanSave, so their timestamps differ by ms. We
 * compare at day granularity so edge-of-second drift / time-zone
 * conversions don't miss the link.
 *
 * Used by EntryCrud.deleteVoyage when a planned_* voyageId is wiped
 * from the logbook — keeps the active-passage dropdown clean of
 * orphaned voyage rows. Returns the count of voyages deleted.
 */
export async function deleteDraftVoyagesByNameAndDay(name: string, dayKey: string): Promise<number> {
    const norm = name.trim().toLowerCase();

    // Offline path — local-storage cache.
    if (!supabase) {
        try {
            const raw = localStorage.getItem('thalassa_draft_voyages');
            if (!raw) return 0;
            const drafts = JSON.parse(raw) as Voyage[];
            const remaining = drafts.filter((v) => {
                const sameName = v.voyage_name.trim().toLowerCase() === norm;
                if (!sameName) return true; // keep
                const vDay = new Date(v.created_at).toISOString().slice(0, 10);
                return vDay !== dayKey; // keep if different day
            });
            const removed = drafts.length - remaining.length;
            if (removed > 0) localStorage.setItem('thalassa_draft_voyages', JSON.stringify(remaining));
            return removed;
        } catch {
            return 0;
        }
    }

    // Online path — Supabase. Fetch candidates first so we can apply the
    // case-insensitive trim + day filter in JS (Supabase has limited
    // built-in support for "trim then lowercase").
    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) return 0;

    const { data: candidates, error: fetchErr } = await supabase
        .from('voyages')
        .select('id, voyage_name, created_at')
        .eq('user_id', user.id)
        .eq('status', 'planning');
    if (fetchErr || !candidates) return 0;

    const ids = candidates
        .filter((v) => {
            if ((v.voyage_name as string).trim().toLowerCase() !== norm) return false;
            const vDay = new Date(v.created_at as string).toISOString().slice(0, 10);
            return vDay === dayKey;
        })
        .map((v) => v.id as string);
    if (ids.length === 0) return 0;

    const { error: delErr } = await supabase.from('voyages').delete().in('id', ids);
    if (delErr) return 0;

    // Drop the local cache so getDraftVoyages doesn't return the deleted
    // rows on its next call.
    try {
        const raw = localStorage.getItem('thalassa_draft_voyages');
        if (raw) {
            const drafts = JSON.parse(raw) as Voyage[];
            const remaining = drafts.filter((v) => !ids.includes(v.id));
            localStorage.setItem('thalassa_draft_voyages', JSON.stringify(remaining));
        }
    } catch {
        /* full / unavailable */
    }

    return ids.length;
}

/** Get all draft (planning) voyages for the current user */
export async function getDraftVoyages(): Promise<Voyage[]> {
    if (!supabase) {
        try {
            const raw = localStorage.getItem('thalassa_draft_voyages');
            return raw ? JSON.parse(raw) : [];
        } catch {
            return [];
        }
    }

    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) return [];

    const { data, error } = await supabase
        .from('voyages')
        .select('*')
        .eq('user_id', user.id)
        .eq('status', 'planning')
        .order('created_at', { ascending: false });

    if (error) return [];
    const drafts = (data || []) as Voyage[];
    try {
        localStorage.setItem('thalassa_draft_voyages', JSON.stringify(drafts));
    } catch {
        /* full */
    }
    return drafts;
}

/**
 * Cast Off — Manual activation of a draft voyage.
 *
 * 1. Checks no other voyage is ACTIVE
 * 2. Transitions status DRAFT → ACTIVE
 * 3. Locks the manifest (no more crew changes)
 * 4. Initialises Voyage Log with a 'Departure' entry
 */
export async function castOff(voyageId: string): Promise<{ ok: boolean; voyage?: Voyage; error?: string }> {
    // State protection: block if another voyage is active
    const active = await getActiveVoyage();
    if (active) {
        return { ok: false, error: `"${active.voyage_name}" is already active. End it first.` };
    }

    const voyage = await startVoyage(voyageId);
    if (!voyage) {
        return { ok: false, error: 'Failed to activate voyage' };
    }

    // Lock manifest — mark all crew invites as locked
    if (supabase) {
        await supabase
            .from('vessel_crew')
            .update({ status: 'confirmed' })
            .eq('owner_id', voyage.user_id)
            .eq('status', 'pending');
    }

    // Voyage log departure entry (local + sync queue)
    try {
        const { insertLocal } = await import('./vessel/LocalDatabase');
        await insertLocal('voyage_log', {
            id: crypto.randomUUID(),
            voyage_id: voyageId,
            entry_type: 'departure',
            timestamp: new Date().toISOString(),
            notes: `Departed ${voyage.departure_port || 'port'} — Cast Off by Skipper`,
            data: JSON.stringify({
                port: voyage.departure_port,
                crew_count: voyage.crew_count,
                voyage_name: voyage.voyage_name,
            }),
        });
    } catch {
        /* offline — log entry will sync later */
    }

    // Create Leg 1 — every cast off starts the first passage leg
    startLeg(voyageId, voyage.departure_port || 'Unknown Port');

    return { ok: true, voyage };
}

/** End a passage — closes active leg and archives the voyage */
export async function endVoyage(voyageId: string, status: 'completed' | 'aborted' = 'completed'): Promise<boolean> {
    // Close any active leg before ending the voyage
    const activeLeg = getActiveLeg(voyageId);
    if (activeLeg) {
        // Use the voyage destination as the arrival port for the final leg
        const cached = getCachedActiveVoyage();
        closeLeg(voyageId, cached?.destination_port || 'Destination');
    }

    if (!supabase) return false;

    const { error } = await supabase.from('voyages').update({ status }).eq('id', voyageId);

    if (!error) {
        cacheVoyage(null);
        // Clean up legs if voyage was aborted
        if (status === 'aborted') {
            deleteLegsForVoyage(voyageId);
        }
    }
    return !error;
}

/**
 * Hard-delete a voyage row by ID, regardless of status. Used by the
 * "Manage saved trips" cleanup sheet so the user can purge orphan or
 * test voyages that don't show up in the normal drafts/active flows.
 *
 * Also clears the cached active voyage if it matches the deleted ID
 * so the hero band / SystemStatusButton drop out of Active Voyage Mode
 * in the same tick.
 *
 * Does NOT cascade to shiplog entries — call ShipLogService.deleteVoyage
 * separately if you also need to remove a planned route's entries.
 * Returns true if a row was removed (or nothing to remove was found
 * locally either).
 */
export async function deleteVoyageById(voyageId: string): Promise<boolean> {
    if (!supabase) return false;

    // Clean up local state synchronously so the UI reflects the
    // delete even if the network round-trip lags.
    deleteLegsForVoyage(voyageId);
    const cached = getCachedActiveVoyage();
    if (cached?.id === voyageId) cacheVoyage(null);

    try {
        const { error } = await supabase.from('voyages').delete().eq('id', voyageId);
        if (error) {
            console.warn('[VoyageService] deleteVoyageById failed:', error.message);
            return false;
        }
    } catch (e) {
        console.warn('[VoyageService] deleteVoyageById threw:', e);
        return false;
    }

    // Drop the local drafts cache so getDraftVoyages() doesn't keep
    // resurrecting the deleted row from localStorage.
    try {
        const raw = localStorage.getItem('thalassa_draft_voyages');
        if (raw) {
            const drafts = JSON.parse(raw) as Voyage[];
            const remaining = drafts.filter((v) => v.id !== voyageId);
            localStorage.setItem('thalassa_draft_voyages', JSON.stringify(remaining));
        }
    } catch {
        /* ignore */
    }

    return true;
}

/** List ALL voyages for the current user — any status. Used by the
 *  cleanup sheet to show even completed/aborted/orphan rows that the
 *  draft-only `getDraftVoyages()` filter would hide. */
export async function getAllVoyagesForUser(): Promise<Voyage[]> {
    if (!supabase) return [];
    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) return [];
    const { data, error } = await supabase
        .from('voyages')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });
    if (error) {
        console.warn('[VoyageService] getAllVoyagesForUser failed:', error.message);
        return [];
    }
    return (data || []) as Voyage[];
}

/**
 * Cascade-end the cached active voyage if its name matches the given
 * normalised label. Called by EntryCrud.deleteVoyage when a saved
 * planned route is deleted from the logbook so Active Voyage Mode
 * doesn't get stuck when the underlying suggested track is gone.
 *
 * Match strategy: case-insensitive trimmed equality on voyage_name.
 * This is the same scheme PassagePlanSave uses to wire saved routes
 * to voyage records, so the inverse side correctly identifies the
 * voyage to end.
 *
 * Returns true if a matching active voyage was found AND ended.
 * Always clears the cached active-voyage state and dispatches the
 * `thalassa:active-voyage-changed` event so any UI listening
 * (SystemStatusButton, MapHub Active Voyage Mode auto-display, the
 * Cast Off pill on VesselHub) drops out of active-voyage state in
 * the same tick.
 */
export async function endActiveVoyageIfNameMatches(label: string): Promise<boolean> {
    const norm = label.trim().toLowerCase();
    if (!norm) return false;

    const cached = getCachedActiveVoyage();
    if (!cached) return false;
    if (cached.voyage_name.trim().toLowerCase() !== norm) return false;

    // Online path — flip the DB status to 'aborted' so any other
    // client (web tab, second device) sees the voyage end too. Use
    // 'aborted' rather than 'completed' since the user deleted the
    // underlying route — they're not signalling a successful arrival.
    if (supabase) {
        try {
            const ok = await endVoyage(cached.id, 'aborted');
            if (ok) return true;
            // endVoyage returned false — fall through to local-only
            // teardown so the user still escapes Active Voyage Mode
            // even if the DB write failed.
        } catch {
            /* fall through */
        }
    }

    // Offline / DB-write-failed path — the user pressed delete and
    // expects the active mode to clear immediately. Mirror what
    // endVoyage does locally: drop the cache + delete the legs so
    // the picker / hero card / system status button all reset.
    deleteLegsForVoyage(cached.id);
    cacheVoyage(null);
    return true;
}

/** Get the currently active voyage */
export async function getActiveVoyage(): Promise<Voyage | null> {
    if (!supabase) return getCachedActiveVoyage();

    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) return getCachedActiveVoyage();

    // Check as owner first
    let { data } = await supabase
        .from('voyages')
        .select('*')
        .eq('user_id', user.id)
        .eq('status', 'active')
        .limit(1)
        .maybeSingle();

    // If not owner, check as crew
    if (!data) {
        const { data: crewVoyage } = await supabase
            .from('voyages')
            .select('*')
            .eq('status', 'active')
            .limit(1)
            .maybeSingle();
        data = crewVoyage;
    }

    const voyage = data as Voyage | null;
    cacheVoyage(voyage);
    return voyage;
}

/** Set the weather master for a voyage (Iridium lock) */
export async function setWeatherMaster(voyageId: string, userId: string): Promise<boolean> {
    if (!supabase) return false;

    const { error } = await supabase.from('voyages').update({ weather_master_id: userId }).eq('id', voyageId);

    return !error;
}

/** Check if current user is the weather master */
export async function isWeatherMaster(): Promise<boolean> {
    if (!supabase) {
        const cached = getCachedActiveVoyage();
        if (!cached) return true; // No voyage = unrestricted
        const userId = localStorage.getItem('thalassa_user_id');
        return cached.weather_master_id === userId || cached.user_id === userId;
    }

    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) return true; // Offline — allow

    const voyage = await getActiveVoyage();
    if (!voyage) return true; // No active voyage — unrestricted

    return voyage.weather_master_id === user.id || voyage.user_id === user.id;
}
