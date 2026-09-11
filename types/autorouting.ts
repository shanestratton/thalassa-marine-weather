/** Thalassa's isolated trial boundary, not the upstream SevenCs wire format. */
export interface AutoroutingTrialRequest {
    departure: { lat: number; lon: number };
    destination: { lat: number; lon: number };
    draftM: number;
    speedKts: number;
}

export interface AutoroutingTrialStatus {
    enabled: boolean;
    ready: boolean;
    message?: string;
}

/** A proposal only: receipt does not save, verify, follow or publish a route. */
export interface AutoroutingTrialRoute {
    id: string;
    /** Ordered GeoJSON convention: longitude first. Never silently simplified. */
    coordinates: [number, number][];
    warnings: string[];
    /** Preserve the server's timestamp; never restamp a cached proposal as new. */
    createdAt: string;
    provider: 'SevenCs';
    /** Exact provider payloads for later authority review, held only in memory. */
    source?: { rtz: string; geoJson: string };
}

export const AUTOROUTING_TRIAL_MAX_POINTS = 10_000;
export const AUTOROUTING_TRIAL_MAX_WARNINGS = 100;
export const AUTOROUTING_TRIAL_MAX_WARNING_LENGTH = 2_000;
export const AUTOROUTING_TRIAL_MAX_DRAFT_M = 30;
export const AUTOROUTING_TRIAL_MAX_SPEED_KTS = 100;
export const AUTOROUTING_TRIAL_MAX_SOURCE_BYTES = 4 * 1024 * 1024;
