/**
 * VoyageLegService — Passage leg lifecycle management.
 *
 * Manages multi-stop voyage legs for logbook entries.
 * Each departure from a port creates a new leg:
 *   Leg 1: Home Port → Stopover A
 *   Leg 2: Stopover A → Stopover B
 *   Leg 3: Stopover B → Destination
 *
 * Uses localStorage for offline-first storage with Supabase sync.
 */

import { PassageLeg } from '../types/navigation';
import { createLogger } from '../utils/createLogger';

const log = createLogger('VoyageLegService');

// ── Local Storage ──────────────────────────────────────────────

const LEGS_KEY = 'thalassa_voyage_legs';

function loadLegs(): PassageLeg[] {
    try {
        const raw = localStorage.getItem(LEGS_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch {
        return [];
    }
}

function saveLegs(legs: PassageLeg[]): void {
    try {
        localStorage.setItem(LEGS_KEY, JSON.stringify(legs));
    } catch {
        /* storage full */
    }
}

// ── Queries ────────────────────────────────────────────────────

/** Get all legs for a voyage, sorted by leg_number */
export function getLegsForVoyage(voyageId: string): PassageLeg[] {
    return loadLegs()
        .filter((l) => l.voyage_id === voyageId)
        .sort((a, b) => a.leg_number - b.leg_number);
}

/** Get the currently active leg for a voyage (status = 'active') */
export function getActiveLeg(voyageId: string): PassageLeg | null {
    return loadLegs().find((l) => l.voyage_id === voyageId && l.status === 'active') ?? null;
}

/** Get the current leg number (highest leg_number for this voyage, or 0 if none) */
export function getCurrentLegNumber(voyageId: string): number {
    const legs = getLegsForVoyage(voyageId);
    if (legs.length === 0) return 0;
    return Math.max(...legs.map((l) => l.leg_number));
}

// ── Mutations ──────────────────────────────────────────────────

/**
 * Start a new leg (called on Cast Off or when departing a stopover).
 *
 * @param voyageId  The parent voyage UUID
 * @param departurePort  Name of the port being departed from
 * @returns The newly created leg
 */
export function startLeg(voyageId: string, departurePort: string): PassageLeg {
    const legs = loadLegs();
    const voyageLegs = legs.filter((l) => l.voyage_id === voyageId);
    const nextNumber = voyageLegs.length > 0 ? Math.max(...voyageLegs.map((l) => l.leg_number)) + 1 : 1;

    const leg: PassageLeg = {
        id: crypto.randomUUID(),
        voyage_id: voyageId,
        leg_number: nextNumber,
        departure_port: departurePort,
        arrival_port: null,
        departure_time: new Date().toISOString(),
        arrival_time: null,
        distance_nm: null,
        status: 'active',
        notes: null,
        created_at: new Date().toISOString(),
    };

    legs.push(leg);
    saveLegs(legs);

    log.info(`✓ Started Leg ${nextNumber}: Departing ${departurePort} (voyage=${voyageId.slice(0, 8)})`);
    return leg;
}

/**
 * Close the current leg (called on arrival at a port/stopover).
 *
 * @param voyageId  The parent voyage UUID
 * @param arrivalPort  Name of the port arrived at
 * @param distanceNm  Optional distance covered during this leg
 * @returns The closed leg, or null if no active leg found
 */
export function closeLeg(voyageId: string, arrivalPort: string, distanceNm?: number): PassageLeg | null {
    const legs = loadLegs();
    const idx = legs.findIndex((l) => l.voyage_id === voyageId && l.status === 'active');

    if (idx === -1) {
        log.warn('No active leg to close for voyage', voyageId.slice(0, 8));
        return null;
    }

    legs[idx] = {
        ...legs[idx],
        arrival_port: arrivalPort,
        arrival_time: new Date().toISOString(),
        distance_nm: distanceNm ?? null,
        status: 'completed',
    };

    saveLegs(legs);

    const closed = legs[idx];
    log.info(
        `✓ Closed Leg ${closed.leg_number}: ${closed.departure_port} → ${arrivalPort}` +
            (distanceNm ? ` (${distanceNm.toFixed(1)} NM)` : ''),
    );

    return closed;
}

/**
 * Get a voyage leg summary (for logbook display).
 * Returns leg info with derived duration.
 */
export function getLegSummary(leg: PassageLeg): {
    legNumber: number;
    route: string;
    departureTime: string;
    arrivalTime: string | null;
    durationHours: number | null;
    distanceNm: number | null;
    status: 'active' | 'completed';
} {
    let durationHours: number | null = null;
    if (leg.arrival_time) {
        const depMs = new Date(leg.departure_time).getTime();
        const arrMs = new Date(leg.arrival_time).getTime();
        durationHours = Math.round(((arrMs - depMs) / 3_600_000) * 10) / 10;
    }

    return {
        legNumber: leg.leg_number,
        route: `${leg.departure_port} → ${leg.arrival_port || '(at sea)'}`,
        departureTime: leg.departure_time,
        arrivalTime: leg.arrival_time,
        durationHours,
        distanceNm: leg.distance_nm,
        status: leg.status,
    };
}

/**
 * Delete all legs for a voyage (cleanup on voyage delete/abort).
 */
export function deleteLegsForVoyage(voyageId: string): void {
    const legs = loadLegs().filter((l) => l.voyage_id !== voyageId);
    saveLegs(legs);
    log.info(`Deleted all legs for voyage ${voyageId.slice(0, 8)}`);
}
