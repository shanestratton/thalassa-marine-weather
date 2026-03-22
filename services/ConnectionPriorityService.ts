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
let currentState: ConnectionState = detectConnection();

/**
 * Detect current connection quality using Network Information API.
 */
function detectConnection(): ConnectionState {
    if (!navigator.onLine) {
        return { quality: 'offline', type: 'none', effectiveDownlink: 0, saveData: false };
    }

    // Network Information API (Chromium + Android)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nav = navigator as any;
    const conn = nav.connection || nav.mozConnection || nav.webkitConnection;

    if (conn) {
        const type = (conn.type || 'unknown') as string;
        const effectiveType = (conn.effectiveType || '4g') as string;
        const downlink = conn.downlink || 10;
        const saveData = conn.saveData || false;

        // Map to our connection type
        let connType: ConnectionType = 'unknown';
        if (type === 'wifi') connType = 'wifi';
        else if (type === 'cellular') {
            if (effectiveType === '4g') connType = '4g';
            else if (effectiveType === '3g') connType = '3g';
            else connType = '2g';
        } else if (type === 'bluetooth' || type === 'ethernet') {
            connType = 'wifi'; // Treat wired/BT as high-speed
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

    if (prev.quality !== currentState.quality || prev.type !== currentState.type) {
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
    return () => {
        const idx = listeners.indexOf(fn);
        if (idx >= 0) listeners.splice(idx, 1);
    };
}

/** Force satellite mode (manual override for testing or Iridium GO!) */
export function forceSatelliteMode(enabled: boolean): void {
    if (enabled) {
        currentState = {
            quality: 'low',
            type: 'satellite',
            effectiveDownlink: 0.02, // ~20kbps
            saveData: true,
        };
    } else {
        currentState = detectConnection();
    }
    listeners.forEach((fn) => fn(currentState));
}

// ── Start/Stop ─────────────────────────────────────────────────────────────

let pollInterval: ReturnType<typeof setInterval> | null = null;

/** Start monitoring connection quality */
export function startConnectionMonitor(): void {
    // Listen for online/offline events
    window.addEventListener('online', refreshState);
    window.addEventListener('offline', refreshState);

    // Network Information API change event
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conn = (navigator as any).connection;
    if (conn) {
        conn.addEventListener('change', refreshState);
    }

    // Poll every 30s as fallback
    pollInterval = setInterval(refreshState, 30_000);
}

/** Stop monitoring */
export function stopConnectionMonitor(): void {
    window.removeEventListener('online', refreshState);
    window.removeEventListener('offline', refreshState);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conn = (navigator as any).connection;
    if (conn) {
        conn.removeEventListener('change', refreshState);
    }

    if (pollInterval) {
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
