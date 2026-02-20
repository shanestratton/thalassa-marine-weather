/**
 * SmartPolarService — 5-Gate data filtering pipeline for empirical polars.
 * Subscribes to NmeaListenerService, filters for clean sailing conditions,
 * and records accepted samples into SmartPolarStore.
 *
 * Gate 1: Engine Off (RPM=0 or no alternator spike)
 * Gate 2: Stable Heading (ROT < 3°/s — no tacking/gybing)
 * Gate 3: Steady Wind (TWS/TWA stable for 30s window)
 * Gate 4: Minimum Speed (STW > 1.0 kts)
 * Gate 5: Steady State Timer (all gates pass for ≥30s before recording)
 */
import type { NmeaSample } from '../types';
import { NmeaListenerService } from './NmeaListenerService';
import { SmartPolarStore } from './SmartPolarStore';

// ── Filter thresholds ──
const MAX_RPM = 0;
const ALT_VOLTAGE_THRESHOLD = 14.2; // Volts — alternator charging spike
const MAX_ROT_DEG_PER_SEC = 3.0;    // Rate of Turn threshold
const TWS_STD_MAX = 3.0;            // Max TWS std-dev over window
const TWA_STD_MAX = 15.0;           // Max TWA std-dev over window
const MIN_STW = 1.0;                // Minimum boat speed (kts)
const STEADY_STATE_SEC = 30;         // Seconds of clean data before recording
const ROLLING_WINDOW_SEC = 30;       // Window for std-dev calculations

export type FilterGateStatus = 'pass' | 'fail' | 'unavailable';

export interface FilterStatus {
    engineOff: FilterGateStatus;
    stableHeading: FilterGateStatus;
    steadyWind: FilterGateStatus;
    minimumSpeed: FilterGateStatus;
    steadyState: FilterGateStatus;
    recording: boolean;
    totalAccepted: number;
    totalRejected: number;
}

class SmartPolarServiceClass {
    private unsubscribe: (() => void) | null = null;
    private enabled = false;

    // Rolling window buffers
    private sampleHistory: NmeaSample[] = [];
    private readonly MAX_HISTORY = Math.ceil(ROLLING_WINDOW_SEC / 5) + 2; // ~8 samples

    // Steady-state timer
    private steadyStateStart: number | null = null;
    private recording = false;

    // Stats
    private totalAccepted = 0;
    private totalRejected = 0;

    // Status listeners
    private statusListeners: Set<(s: FilterStatus) => void> = new Set();

    // ── Public API ──

    async start(): Promise<void> {
        if (this.enabled) return;
        this.enabled = true;
        await SmartPolarStore.initialize();
        this.unsubscribe = NmeaListenerService.onSample(sample => this.processSample(sample));
    }

    stop(): void {
        this.enabled = false;
        if (this.unsubscribe) { this.unsubscribe(); this.unsubscribe = null; }
        this.sampleHistory = [];
        this.steadyStateStart = null;
        this.recording = false;
    }

    getStatus(): FilterStatus {
        return this.buildStatus();
    }

    onStatusChange(cb: (s: FilterStatus) => void) {
        this.statusListeners.add(cb);
        return () => this.statusListeners.delete(cb);
    }

    resetStats(): void {
        this.totalAccepted = 0;
        this.totalRejected = 0;
    }

    // ── Core Pipeline ──

    private processSample(sample: NmeaSample): void {
        // Push to history
        this.sampleHistory.push(sample);
        if (this.sampleHistory.length > this.MAX_HISTORY) {
            this.sampleHistory.shift();
        }

        // Run 5-gate filter
        const gate1 = this.gateEngineOff(sample);
        const gate2 = this.gateStableHeading();
        const gate3 = this.gateSteadyWind();
        const gate4 = this.gateMinimumSpeed(sample);

        const allPass = gate1 !== 'fail' && gate2 !== 'fail' && gate3 !== 'fail' && gate4 !== 'fail';

        // Gate 5: Steady state timer
        if (allPass) {
            if (this.steadyStateStart === null) {
                this.steadyStateStart = sample.timestamp;
            }
            const steadyDuration = (sample.timestamp - this.steadyStateStart) / 1000;
            this.recording = steadyDuration >= STEADY_STATE_SEC;
        } else {
            this.steadyStateStart = null;
            this.recording = false;
        }

        // Record if all gates pass and steady state reached
        if (this.recording && sample.tws !== null && sample.twa !== null && sample.stw !== null) {
            SmartPolarStore.recordSample(sample.tws, sample.twa, sample.stw);
            this.totalAccepted++;
        } else if (!allPass) {
            this.totalRejected++;
        }

        // Notify status listeners
        this.emitStatus();
    }

    // ── Gate 1: Engine Off ──
    private gateEngineOff(sample: NmeaSample): FilterGateStatus {
        // If RPM data available, check it
        if (sample.rpm !== null) {
            return sample.rpm <= MAX_RPM ? 'pass' : 'fail';
        }
        // Fallback: check alternator voltage spike
        if (sample.voltage !== null) {
            return sample.voltage < ALT_VOLTAGE_THRESHOLD ? 'pass' : 'fail';
        }
        // Neither available — mark as unavailable (not a hard fail)
        return 'unavailable';
    }

    // ── Gate 2: Stable Heading (Rate of Turn) ──
    private gateStableHeading(): FilterGateStatus {
        if (this.sampleHistory.length < 2) return 'unavailable';

        const recent = this.sampleHistory.slice(-2);
        const h0 = recent[0].heading;
        const h1 = recent[1].heading;
        if (h0 === null || h1 === null) return 'unavailable';

        const dt = (recent[1].timestamp - recent[0].timestamp) / 1000;
        if (dt <= 0) return 'unavailable';

        // Handle compass wrap-around (350° → 10° = 20° change, not 340°)
        let delta = Math.abs(h1 - h0);
        if (delta > 180) delta = 360 - delta;

        const rot = delta / dt; // degrees per second
        return rot <= MAX_ROT_DEG_PER_SEC ? 'pass' : 'fail';
    }

    // ── Gate 3: Steady Wind (std-dev over rolling window) ──
    private gateSteadyWind(): FilterGateStatus {
        const windowSamples = this.getWindowSamples();
        if (windowSamples.length < 3) return 'unavailable';

        const twsValues = windowSamples.map(s => s.tws).filter((v): v is number => v !== null);
        const twaValues = windowSamples.map(s => s.twa).filter((v): v is number => v !== null);

        if (twsValues.length < 3 || twaValues.length < 3) return 'unavailable';

        const twsStd = stdDev(twsValues);
        const twaStd = stdDev(twaValues);

        if (twsStd > TWS_STD_MAX || twaStd > TWA_STD_MAX) return 'fail';
        return 'pass';
    }

    // ── Gate 4: Minimum Speed ──
    private gateMinimumSpeed(sample: NmeaSample): FilterGateStatus {
        if (sample.stw === null) return 'unavailable';
        return sample.stw >= MIN_STW ? 'pass' : 'fail';
    }

    // ── Helpers ──

    private getWindowSamples(): NmeaSample[] {
        const cutoff = Date.now() - ROLLING_WINDOW_SEC * 1000;
        return this.sampleHistory.filter(s => s.timestamp >= cutoff);
    }

    private buildStatus(): FilterStatus {
        const latest = this.sampleHistory[this.sampleHistory.length - 1];
        return {
            engineOff: latest ? this.gateEngineOff(latest) : 'unavailable',
            stableHeading: this.gateStableHeading(),
            steadyWind: this.gateSteadyWind(),
            minimumSpeed: latest ? this.gateMinimumSpeed(latest) : 'unavailable',
            steadyState: this.recording ? 'pass' : (this.steadyStateStart !== null ? 'unavailable' : 'fail'),
            recording: this.recording,
            totalAccepted: this.totalAccepted,
            totalRejected: this.totalRejected,
        };
    }

    private emitStatus(): void {
        const status = this.buildStatus();
        for (const cb of this.statusListeners) cb(status);
    }
}

/** Standard deviation of a number array */
function stdDev(arr: number[]): number {
    if (arr.length < 2) return 0;
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const variance = arr.reduce((sum, v) => sum + (v - mean) ** 2, 0) / arr.length;
    return Math.sqrt(variance);
}

export const SmartPolarService = new SmartPolarServiceClass();
