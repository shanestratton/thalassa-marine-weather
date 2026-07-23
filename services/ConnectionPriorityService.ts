/**
 * ConnectionPriorityService — Network-aware data throttling.
 *
 * Detects connection quality (WiFi → 4G → Satellite → Offline) and
 * enforces priority rules:
 *
 *  HIGH signal (WiFi/4G):  All operations allowed
 *  LOW signal (Sat/2G):    Only Report Position + Delta Sync (text-only)
 *  OFFLINE:                Only local operations
 *
 * This ensures the crew never burns through satellite data on bulk
 * syncs or image downloads when 200nm offshore on Iridium GO!
 */

// ── Types ──────────────────────────────────────────────────────────────────

export type SignalQuality = 'high' | 'low' | 'offline';
export type ConnectionType = 'wifi' | '4g' | '3g' | '2g' | 'satellite' | 'unknown' | 'none';

export type DataPriority = 'critical' | 'normal' | 'bulk';

export interface ConnectionState {
    quality: SignalQuality;
    type: ConnectionType;
    effectiveDownlink: number; // Mbps estimate
    saveData: boolean;
}

interface PriorityRule {
    /** Human-readable description */
    label: string;
    /** Minimum signal quality required */
    minQuality: SignalQuality;
}

// ── Priority Rules ─────────────────────────────────────────────────────────

const PRIORITY_RULES: Record<DataPriority, PriorityRule> = {
    critical: {
        label: 'Report Position / Delta Sync / Text Messages',
        minQuality: 'offline', // Always allowed (queued if offline)
    },
    normal: {
        label: 'Recipe fetch / Weather updates / Crew sync',
        minQuality: 'low',
    },
    bulk: {
        label: 'Image upload / Full sync / PDF generation / Recipe images',
        minQuality: 'high',
    },
};

// ── Signal Quality Detection ───────────────────────────────────────────────

type StatusListener = (state: ConnectionState) => void;
const listeners: StatusListener[] = [];
let satelliteOverride = false;
let currentState: ConnectionState = detectConnection();

interface NetworkConnection extends EventTarget {
    type?: string;
    effectiveType?: string;
    downlink?: number;
    saveData?: boolean;
}

interface NavigatorWithConnection extends Navigator {
    connection?: NetworkConnection;
    mozConnection?: NetworkConnection;
    webkitConnection?: NetworkConnection;
}

function getNetworkConnection(): NetworkConnection | undefined {
    const nav = navigator as NavigatorWithConnection;
    return nav.connection ?? nav.mozConnection ?? nav.webkitConnection;
}

/**
 * Detect current connection quality using Network Information API.
 */
function detectConnection(): ConnectionState {
    if (satelliteOverride) {
        return {
            quality: 'low',
            type: 'satellite',
            effectiveDownlink: 0.02, // ~20kbps
            saveData: true,
        };
    }

    if (!navigator.onLine) {
        return { quality: 'offline', type: 'none', effectiveDownlink: 0, saveData: false };
    }

    // Network Information API (Chromium + Android)
    const conn = getNetworkConnection();

    if (conn) {
        const type = conn.type ?? 'unknown';
        const effectiveType = conn.effectiveType ?? '4g';
        const downlink =
            typeof conn.downlink === 'number' && Number.isFinite(conn.downlink) && conn.downlink >= 0
                ? conn.downlink
                : 10;
        const saveData = conn.saveData === true;

        // Map to our connection type
        let connType: ConnectionType = 'unknown';
        if (type === 'wifi') connType = 'wifi';
        else if (type === 'cellular') {
            if (effectiveType === '4g') connType = '4g';
            else if (effectiveType === '3g') connType = '3g';
            else connType = '2g';
        } else if (type === 'bluetooth' || type === 'ethernet') {
            connType = 'wifi'; // Treat wired/BT as high-speed
        } else if (effectiveType === '4g' || effectiveType === '3g' || effectiveType === '2g') {
            // Chromium commonly exposes effectiveType without exposing type.
            connType = effectiveType;
        } else if (effectiveType === 'slow-2g') {
            connType = '2g';
        }

        // Detect satellite: very low downlink + not wifi
        if (downlink < 0.1 && connType !== 'wifi') {
            connType = 'satellite';
        }

        // Determine quality
        let quality: SignalQuality = 'high';
        if (connType === 'satellite' || connType === '2g' || downlink < 0.5 || saveData) {
            quality = 'low';
        } else if (connType === '3g' && downlink < 1.5) {
            quality = 'low';
        }

        return { quality, type: connType, effectiveDownlink: downlink, saveData };
    }

    // No Network Information API — assume high if online
    return { quality: 'high', type: 'unknown', effectiveDownlink: 10, saveData: false };
}

/**
 * Refresh the connection state and notify listeners.
 */
function refreshState(): void {
    const prev = currentState;
    currentState = detectConnection();

    if (
        prev.quality !== currentState.quality ||
        prev.type !== currentState.type ||
        prev.effectiveDownlink !== currentState.effectiveDownlink ||
        prev.saveData !== currentState.saveData
    ) {
        listeners.forEach((fn) => fn(currentState));
    }
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Get current connection state */
export function getConnectionState(): ConnectionState {
    return currentState;
}

/** Check if a data operation is allowed at the current signal quality */
export function isOperationAllowed(priority: DataPriority): boolean {
    const rule = PRIORITY_RULES[priority];
    const qualityOrder: SignalQuality[] = ['offline', 'low', 'high'];

    const currentIdx = qualityOrder.indexOf(currentState.quality);
    const requiredIdx = qualityOrder.indexOf(rule.minQuality);

    return currentIdx >= requiredIdx;
}

/**
 * Guard a network operation — throws if not allowed.
 * Use before fetch() calls to prevent wasting satellite data.
 */
export function requireConnection(priority: DataPriority, operationName: string): void {
    if (!isOperationAllowed(priority)) {
        throw new ConnectionThrottledError(operationName, currentState, priority);
    }
}

/**
 * Get a human-readable description of what's allowed right now.
 */
export function getAllowedOperations(): string[] {
    return (Object.entries(PRIORITY_RULES) as [DataPriority, PriorityRule][])
        .filter(([priority]) => isOperationAllowed(priority))
        .map(([, rule]) => rule.label);
}

/** Subscribe to connection changes */
export function onConnectionChange(fn: StatusListener): () => void {
    listeners.push(fn);
    // Monitoring is lazy so importing this module does not create a permanent
    // timer, but subscribers still receive real network transitions without
    // requiring a separate bootstrap call.
    startConnectionMonitor();
    return () => {
        const idx = listeners.indexOf(fn);
        if (idx >= 0) listeners.splice(idx, 1);
        if (listeners.length === 0) stopConnectionMonitor();
    };
}

/** Force satellite mode (manual override for testing or Iridium GO!) */
export function forceSatelliteMode(enabled: boolean): void {
    satelliteOverride = enabled;
    currentState = detectConnection();
    listeners.forEach((fn) => fn(currentState));
}

// ── Start/Stop ─────────────────────────────────────────────────────────────

let pollInterval: ReturnType<typeof setInterval> | null = null;
let monitorStarted = false;
let monitoredConnection: NetworkConnection | undefined;

/** Start monitoring connection quality */
export function startConnectionMonitor(): void {
    if (monitorStarted) return;
    monitorStarted = true;

    // Listen for online/offline events
    window.addEventListener('online', refreshState);
    window.addEventListener('offline', refreshState);

    // Network Information API change event
    monitoredConnection = getNetworkConnection();
    monitoredConnection?.addEventListener('change', refreshState);

    // Poll every 30s as fallback
    pollInterval = setInterval(refreshState, 30_000);
    refreshState();
}

/** Stop monitoring */
export function stopConnectionMonitor(): void {
    if (!monitorStarted) return;
    monitorStarted = false;

    window.removeEventListener('online', refreshState);
    window.removeEventListener('offline', refreshState);

    // Remove the listener from the exact connection object used at start. The
    // browser may replace navigator.connection after a network transition.
    monitoredConnection?.removeEventListener('change', refreshState);
    monitoredConnection = undefined;

    if (pollInterval !== null) {
        clearInterval(pollInterval);
        pollInterval = null;
    }
}

// ── Error Type ─────────────────────────────────────────────────────────────

export class ConnectionThrottledError extends Error {
    constructor(
        public operation: string,
        public connectionState: ConnectionState,
        public requiredPriority: DataPriority,
    ) {
        super(
            `[Network Throttle] "${operation}" blocked — signal: ${connectionState.type} (${connectionState.quality}). ` +
                `Only critical operations allowed on satellite/low signal.`,
        );
        this.name = 'ConnectionThrottledError';
    }
}
