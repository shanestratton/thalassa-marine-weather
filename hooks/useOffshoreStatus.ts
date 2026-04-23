/**
 * useOffshoreStatus — Tracks coastal/offshore transitions.
 *
 * Watches the current weather report's `locationType` and detects when
 * the vessel crosses the 20 nm offshore boundary.  Exposes:
 *
 *   isOffshore        — true when beyond 20 nm
 *   offshoreModel     — user's chosen Stormglass source label
 *   offshoreModelCode — raw code ('sg' | 'ecmwf' | 'gfs' | 'icon')
 *   justCrossed       — true for 5 s after a coastal→offshore transition
 *   testToggle()      — simulate a boundary crossing (dev/QA only)
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useSettingsStore } from '../stores/settingsStore';
import type { OffshoreModel } from '../types';

// Kept short enough to fit "OFFSHORE (XXX)" on a single line in the
// header status badge alongside all the other offshore models. "Stormglass
// AI" was the only one that wrapped to a second line.
const MODEL_LABELS: Record<OffshoreModel, string> = {
    sg: 'SG AI',
    ecmwf: 'ECMWF',
    gfs: 'GFS / NOAA',
    icon: 'ICON',
};

export interface OffshoreStatus {
    /** True when the vessel is beyond 20 nm */
    isOffshore: boolean;
    /** Human-readable model name, e.g. "ECMWF" */
    offshoreModel: string;
    /** Raw Stormglass source code */
    offshoreModelCode: OffshoreModel;
    /** True for ~5 s after a coastal→offshore transition (drives the toast) */
    justCrossed: boolean;
    /** Flip isOffshore for testing without GPS movement */
    testToggle: () => void;
    /** Whether we're in test-override mode */
    isTestMode: boolean;
}

export function useOffshoreStatus(locationType?: 'inshore' | 'coastal' | 'offshore' | 'inland'): OffshoreStatus {
    const modelCode = (useSettingsStore((s) => s.settings.offshoreModel) || 'sg') as OffshoreModel;

    // Override state for the test toggle
    const [testOverride, setTestOverride] = useState<boolean | null>(null);

    // Derived offshore flag
    const isOffshore = testOverride !== null ? testOverride : locationType === 'offshore';

    // Transition detection
    const prevOffshore = useRef(isOffshore);
    const [justCrossed, setJustCrossed] = useState(false);

    useEffect(() => {
        // Detect coastal → offshore flip
        if (isOffshore && !prevOffshore.current) {
            setJustCrossed(true);
            const timer = setTimeout(() => setJustCrossed(false), 5000);
            return () => clearTimeout(timer);
        }
        // Detect offshore → coastal flip (clear flag immediately)
        if (!isOffshore && prevOffshore.current) {
            setJustCrossed(false);
        }
        prevOffshore.current = isOffshore;
    }, [isOffshore]);

    const testToggle = useCallback(() => {
        setTestOverride((prev) => {
            if (prev === null) return true; // First toggle: force offshore
            if (prev === true) return false; // Second: force coastal
            return null; // Third: release back to real data
        });
    }, []);

    return {
        isOffshore,
        offshoreModel: MODEL_LABELS[modelCode],
        offshoreModelCode: modelCode,
        justCrossed,
        testToggle,
        isTestMode: testOverride !== null,
    };
}
