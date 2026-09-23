import type { AutoroutingProviderCheck } from '../supabase/functions/_shared/autorouting-provider-check';
import type { AutoroutingVesselProfile } from '../supabase/functions/_shared/autorouting-vessel';
export type { AutoroutingDimension, AutoroutingVesselProfile } from '../supabase/functions/_shared/autorouting-vessel';
export type {
    AutoroutingProviderCheck,
    AutoroutingProviderFinding,
} from '../supabase/functions/_shared/autorouting-provider-check';

/** Thalassa's isolated trial boundary, not the upstream SevenCs wire format. */
export interface AutoroutingTrialRequest {
    departure: { lat: number; lon: number };
    destination: { lat: number; lon: number };
    draftM: number;
    speedKts: number;
    /** Omitted only by legacy clients; missing values never become zero dimensions. */
    vesselProfile?: AutoroutingVesselProfile;
    /** Explicit, ordered chart-track positions for a guided recalculation.
     * Omit unless the server advertises channelGuidance support. */
    chartTrackConstraints?: { lat: number; lon: number }[];
}

export interface AutoroutingTrialStatus {
    enabled: boolean;
    ready: boolean;
    /** Only explicit true advertises support; older servers omit this field. */
    channelGuidance?: boolean;
    /** Explicit true is required before sending a vessel-profile request. */
    vesselProfile?: boolean;
    message?: string;
}

/** A proposal only: receipt does not save, verify, follow or publish a route. */
export interface AutoroutingTrialRoute {
    id: string;
    /** Ordered GeoJSON convention: longitude first. Never silently simplified. */
    coordinates: [number, number][];
    warnings: string[];
    /** Provider findings apply to its proposal, not to every local review leg.
     * Omitted by older servers; missing/no findings never means cleared. */
    providerCheck?: AutoroutingProviderCheck;
    /** Preserve the server's timestamp; never restamp a cached proposal as new. */
    createdAt: string;
    provider: 'SevenCs';
    /** Exact accepted Thalassa snapshot, not a provider certification of measurements. */
    vesselProfile?: AutoroutingVesselProfile;
    /** Exact provider payloads for later authority review, held only in memory. */
    source?: { rtz: string; geoJson: string };
    /** Local geometry precedes SevenCs. source remains the unmodified provider
     * continuation, not a provider endorsement of the local canal section. */
    canalDeparture?: { handoverIndex: number };
    /** A local edit invalidates the original provider AND canal gate evidence.
     * canalDeparture then identifies a section boundary only, not a checked exit.
     * Fresh local checks do not constitute a fresh SevenCs check. Memory only. */
    localEdit?: AutoroutingLocalEdit;
}

export interface AutoroutingLocalEdit {
    readonly revision: number;
    readonly checksInvalidated: 'provider-and-canal';
    /** Full-path indices retained as display pins, shifted when a move inserts
     * a vertex. They are user edit anchors, not validated canal gates. */
    readonly waypointIndices: readonly number[];
    /** Deep-frozen, detached original proposal. Findings/source are historical,
     * never findings or clearance for the current edited geometry. */
    readonly originalProposal: Readonly<Omit<AutoroutingTrialRoute, 'localEdit'>>;
}

export const AUTOROUTING_TRIAL_MAX_POINTS = 10_000;
export const AUTOROUTING_TRIAL_MAX_CHART_TRACK_CONSTRAINTS = 8;
export const AUTOROUTING_TRIAL_MAX_WARNINGS = 100;
export const AUTOROUTING_TRIAL_MAX_WARNING_LENGTH = 2_000;
export const AUTOROUTING_TRIAL_MAX_DRAFT_M = 30;
export const AUTOROUTING_TRIAL_MAX_SPEED_KTS = 100;
export const AUTOROUTING_TRIAL_MAX_SOURCE_BYTES = 4 * 1024 * 1024;
