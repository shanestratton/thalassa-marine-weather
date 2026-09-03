/**
 * Shared types for the Vessel Hub (Nav Station) surface.
 *
 * Lifted verbatim out of components/VesselHub.tsx when that file was split
 * into this directory; the component contracts are unchanged.
 */
import React from 'react';
import { type SkipperClaim } from '../../services/skipperDevice';

export interface VesselHubProps {
    onNavigate: (page: string) => void;
    settings: Record<string, unknown>;
    onSave: (updates: Record<string, unknown>) => void;
}

export interface SkipperDeviceControlProps {
    claim: SkipperClaim | null;
    authenticatedUserId: string | null;
    updateSettings: (patch: { skipperDevice?: SkipperClaim }) => void;
    /**
     * The active fleet vessel this device publishes for. The claim is what
     * grants publishing authority, but authority alone never said WHICH boat
     * it speaks for — with up to five in a fleet, "this device is publishing"
     * is only half an answer. Shown here so the card is the single place that
     * states both.
     */
    vesselName?: string;
}

/** Metric chip data — single source of truth for what a chip renders.
 *  Either icon+value (wind, wave, temp, visibility) OR label+value
 *  (BAR ↑, TIDE ↓ — trend indicators with no numeric value). */
export interface MetricChipData {
    key: string;
    /** Optional leading SVG icon. ReactNode so callers can pass any
     *  Icons-barrel component (WindIcon, WaveIcon, etc) sized to fit. */
    icon?: React.ReactNode;
    label?: string;
    value: string;
    unit?: string;
    suffix?: string;
    color?: string;
    ariaLabel?: string;
}
