/**
 * EnvironmentDetectionService — Auto Land/Water Detection Plugin
 * ─────────────────────────────────────────────────────────────────
 * Continuously monitors whether the user is on land (onshore) or
 * water (offshore) and exposes a reactive state for the theme system.
 *
 * Detection signals (ranked by confidence):
 * 1. Cached weather locationType (inland = onshore, coastal/offshore = offshore)
 * 2. isLandlocked flag from weather data
 * 3. Elevation data (> 10m = onshore)
 * 4. Persisted last-known environment (fallback)
 *
 * User can override with manual mode: 'auto' | 'onshore' | 'offshore'
 *
 * Usage:
 *   import { EnvironmentService } from './EnvironmentService';
 *   EnvironmentService.onStateChange((state) => { ... });
 *   EnvironmentService.setMode('auto'); // or 'onshore' / 'offshore'
 */

// ── Types ───────────────────────────────────────────────────────

export type Environment = 'onshore' | 'offshore';
export type EnvironmentMode = 'auto' | 'onshore' | 'offshore';

export interface EnvironmentState {
    /** Resolved environment (respects user override) */
    current: Environment;
    /** What auto-detection determined */
    detected: Environment;
    /** User preference: auto, onshore, or offshore */
    mode: EnvironmentMode;
    /** 0–1 confidence in detection (1 = definitive, 0 = guessing) */
    confidence: number;
    /** Source that determined the detection */
    source: 'weather_type' | 'landlocked' | 'elevation' | 'persisted' | 'default';
}

interface PersistedEnvironment {
    mode: EnvironmentMode;
    detected: Environment;
    savedAt: number;
}

// ── Constants ───────────────────────────────────────────────────

const STORAGE_KEY = 'thalassa_environment';
const DEBOUNCE_CONFIRMATIONS = 2;  // Require N consecutive same-detections before switching
const MAX_AGE_MS = 48 * 60 * 60 * 1000; // 48h — environment data stays relevant longer than sync

// ── Service ─────────────────────────────────────────────────────

class EnvironmentServiceClass {
    private state: EnvironmentState = {
        current: 'offshore',
        detected: 'offshore',
        mode: 'auto',
        confidence: 0,
        source: 'default',
    };

    private listeners = new Set<(state: EnvironmentState) => void>();
    private pendingDetection: Environment | null = null;
    private confirmationCount = 0;

    constructor() {
        this.restoreFromStorage();
    }

    // ── Public API ──────────────────────────────────────────────

    /** Get current environment state */
    getState(): EnvironmentState {
        return { ...this.state };
    }

    /** Set user preference mode */
    setMode(mode: EnvironmentMode): void {
        this.state.mode = mode;

        if (mode === 'auto') {
            // Resolve based on detected environment
            this.state.current = this.state.detected;
        } else {
            // Manual override
            this.state.current = mode;
        }

        this.persist();
        this.notifyListeners();
    }

    /** Subscribe to state changes — returns unsubscribe function */
    onStateChange(cb: (state: EnvironmentState) => void): () => void {
        this.listeners.add(cb);
        // Push current state immediately
        cb(this.getState());
        return () => this.listeners.delete(cb);
    }

    /**
     * Feed weather data into detection.
     * Called by WeatherContext when new weather data arrives.
     */
    updateFromWeatherData(data: {
        locationType?: 'coastal' | 'offshore' | 'inland' | string;
        isLandlocked?: boolean;
        elevation?: number;
    }): void {
        let newDetected: Environment;
        let confidence: number;
        let source: EnvironmentState['source'];

        // Priority 1: locationType (most reliable signal)
        if (data.locationType) {
            if (data.locationType === 'inland') {
                newDetected = 'onshore';
                confidence = 0.95;
                source = 'weather_type';
            } else if (data.locationType === 'offshore') {
                newDetected = 'offshore';
                confidence = 0.95;
                source = 'weather_type';
            } else {
                // 'coastal' — could go either way. Check isLandlocked.
                if (data.isLandlocked === true) {
                    newDetected = 'onshore';
                    confidence = 0.85;
                    source = 'landlocked';
                } else {
                    // Coastal + not landlocked = near water = offshore theme
                    newDetected = 'offshore';
                    confidence = 0.8;
                    source = 'weather_type';
                }
            }
        }
        // Priority 2: isLandlocked fallback
        else if (data.isLandlocked !== undefined) {
            newDetected = data.isLandlocked ? 'onshore' : 'offshore';
            confidence = 0.7;
            source = 'landlocked';
        }
        // Priority 3: Elevation
        else if (data.elevation !== undefined && data.elevation !== null) {
            newDetected = data.elevation > 10 ? 'onshore' : 'offshore';
            confidence = 0.6;
            source = 'elevation';
        }
        // No useful data
        else {
            return; // Don't update — keep existing detection
        }

        this.applyDetection(newDetected, confidence, source);
    }

    /**
     * Feed GPS altitude into detection.
     * Called by BackgroundLocationService when a new location is received.
     * Lower priority than weather data but provides real-time signal.
     */
    updateFromGPS(data: { altitude: number }): void {
        // Only use altitude if it's a meaningful value (not 0 or negative from GPS noise)
        if (data.altitude === undefined || data.altitude === null) return;

        let newDetected: Environment;
        let confidence: number;

        if (data.altitude > 10) {
            // > 10m altitude = almost certainly on land
            newDetected = 'onshore';
            confidence = 0.6;
        } else if (data.altitude < 5) {
            // < 5m altitude near sea level = likely near/on water
            newDetected = 'offshore';
            confidence = 0.5;
        } else {
            // 5-10m = ambiguous, don't update
            return;
        }

        this.applyDetection(newDetected, confidence, 'elevation');
    }

    // ── Private ─────────────────────────────────────────────────

    /**
     * Apply new detection with debounce.
     * Requires DEBOUNCE_CONFIRMATIONS consecutive same-detections
     * before actually switching, to prevent flickering near shore.
     */
    private applyDetection(
        newDetected: Environment,
        confidence: number,
        source: EnvironmentState['source']
    ): void {
        // If same as pending, increment confirmation count
        if (this.pendingDetection === newDetected) {
            this.confirmationCount++;
        } else {
            // New detection — reset counter
            this.pendingDetection = newDetected;
            this.confirmationCount = 1;
        }

        // Only switch after enough confirmations (or if it matches current)
        if (
            this.confirmationCount >= DEBOUNCE_CONFIRMATIONS ||
            newDetected === this.state.detected
        ) {
            const changed = this.state.detected !== newDetected;
            this.state.detected = newDetected;
            this.state.confidence = confidence;
            this.state.source = source;

            // Resolve current based on mode
            if (this.state.mode === 'auto') {
                this.state.current = newDetected;
            }

            if (changed || confidence !== this.state.confidence) {
                this.persist();
                this.notifyListeners();
            }

            // Reset pending
            this.pendingDetection = null;
            this.confirmationCount = 0;
        }
    }

    /** Persist to localStorage */
    private persist(): void {
        try {
            const data: PersistedEnvironment = {
                mode: this.state.mode,
                detected: this.state.detected,
                savedAt: Date.now(),
            };
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        } catch {
            // Non-critical
        }
    }

    /** Restore from localStorage on service init */
    private restoreFromStorage(): void {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return;

            const persisted: PersistedEnvironment = JSON.parse(raw);

            // Validate age
            if (Date.now() - (persisted.savedAt || 0) > MAX_AGE_MS) {
                localStorage.removeItem(STORAGE_KEY);
                return;
            }

            // Restore
            this.state.mode = persisted.mode || 'auto';
            this.state.detected = persisted.detected || 'offshore';
            this.state.source = 'persisted';
            this.state.confidence = 0.5; // Lower confidence for persisted data

            // Resolve current
            if (this.state.mode === 'auto') {
                this.state.current = this.state.detected;
            } else {
                this.state.current = this.state.mode;
            }
        } catch {
            // Corrupted data — start fresh
            localStorage.removeItem(STORAGE_KEY);
        }
    }

    /** Notify all subscribers */
    private notifyListeners(): void {
        const snapshot = this.getState();
        this.listeners.forEach(cb => {
            try { cb(snapshot); } catch { /* Isolated listener error */ }
        });
    }
}

// ── Singleton Export ─────────────────────────────────────────────

export const EnvironmentService = new EnvironmentServiceClass();
