/** Explicit fresh-Window proof only. Globals expose copied fixed observations,
 * never a runtime, controller, native proxy, transport, credential or error.
 * Ordinary App and Research windows have no diagnostic or remount globals.
 */
import type { FullAppIoFence } from './ioFence';
import type { FullAppBoundaryCounters } from './boundaries';
import type { FullAppMemoryCounters } from './boundaryMemory';

export const FULL_APP_WINDOW_EVIDENCE_KEY = '__THALASSA_FULL_APP_WINDOW_EVIDENCE__';
export const FULL_APP_WINDOW_REMOUNT_KEY = '__THALASSA_FULL_APP_WINDOW_REMOUNT__';
const LIMIT = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NONCE = /^[0-9a-f]{64}$/;
const FENCE_COUNTS = [
    'fetch',
    'xhr',
    'webSocket',
    'eventSource',
    'beacon',
    'preservedFetch',
    'preservedXhr',
    'worker',
    'sharedWorker',
    'serviceWorker',
    'caches',
    'indexedDB',
    'geolocation',
    'media',
    'clipboard',
    'audio',
    'navigation',
    'permissions',
    'otherNetwork',
    'localStorageReads',
    'localStorageWrites',
    'sessionStorageReads',
    'sessionStorageWrites',
    'storageRefused',
    'storageManager',
    'patchFailures',
    'locationPatchUnavailable',
    'authRequests',
    'authResponses',
    'authRefused',
] as const;
const BOUNDARY_COUNTS = [
    'instrumentRequests',
    'gpsRequests',
    'internetRequests',
    'aisRequests',
    'appleRequests',
    'anchorRequests',
    'anchorSyncRequests',
    'anchorPiRequests',
    'shiplogRequests',
    'vesselRequests',
    'piRequests',
    'nativeRequests',
    'observations',
    'subscriptions',
    'cleanups',
] as const;
const MEMORY_COUNTS = [
    'preferenceReads',
    'preferenceWrites',
    'preferenceRemovals',
    'preferenceClears',
    'preferenceKeys',
    'cacheReads',
    'cacheWrites',
    'cacheRemovals',
    'cacheFlushes',
    'versionReads',
    'versionWrites',
    'refusals',
] as const;
const AUTH_STATUSES = new Set([
    'unsupported',
    'unavailable',
    'signed_out',
    'verifying',
    'authenticated',
    'detached',
    'inactive',
]);
type AuthStatus =
    | 'unknown'
    | 'unsupported'
    | 'unavailable'
    | 'signed_out'
    | 'verifying'
    | 'authenticated'
    | 'detached'
    | 'inactive';
type ScopeFacts = Readonly<{ userPresent: boolean | null; anonymous: boolean | null; generation: number | null }>;
export interface FullAppWindowGraphObservation {
    readonly auth: Readonly<{ status: string; userPresent: boolean; authChecked: boolean }>;
    readonly scope: unknown;
    readonly legacyPermitAvailable: boolean;
    readonly core: Readonly<{ registrationAttempts: number; methodAttempts: number; platform: 'web' | 'ios' }>;
    readonly boundaries: FullAppBoundaryCounters;
    readonly memory: FullAppMemoryCounters;
}
export interface FullAppWindowEvidence {
    readonly version: 1;
    readonly runId: string;
    readonly phase: 'starting' | 'ready' | 'failed';
    readonly fence: ReturnType<FullAppIoFence['evidence']> | null;
    readonly sdk: Readonly<{ runtimeCreations: number; sdkConstructions: number; nativeCalls: number }>;
    readonly root: Readonly<{ mounts: number; remounts: number; closedRenders: number }>;
    readonly auth: Readonly<{ status: AuthStatus; userPresent: boolean | null; authChecked: boolean | null }>;
    readonly authScope: Readonly<{
        originalUserPresent: boolean | null;
        originalAnonymous: boolean | null;
        originalGeneration: number | null;
        currentUserPresent: boolean | null;
        currentAnonymous: boolean | null;
        currentGeneration: number | null;
    }>;
    readonly privateSelection: 'native-unavailable' | 'native-pilot' | null;
    readonly legacyPermitAvailable: boolean | null;
    readonly core: FullAppWindowGraphObservation['core'] | null;
    readonly boundaries: FullAppBoundaryCounters | null;
    readonly memory: FullAppMemoryCounters | null;
    readonly lifecycle: Readonly<{ stopped: boolean }>;
}

function own(value: unknown, key: string): unknown {
    try {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
        return Object.getOwnPropertyDescriptor(value, key)?.value;
    } catch {
        return undefined;
    }
}
function bounded(value: unknown, limit = LIMIT): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= limit ? value : null;
}
function copyCounts<K extends string>(
    value: unknown,
    keys: readonly K[],
    limit: number,
): Readonly<Record<K, number>> | null {
    const result = {} as Record<K, number>;
    for (const key of keys) {
        const count = bounded(own(value, key), limit);
        if (count === null) return null;
        result[key] = count;
    }
    return Object.freeze(result);
}
function scopeFacts(value: unknown): ScopeFacts {
    try {
        const key = own(value, 'key'),
            user = own(value, 'userId'),
            generation = bounded(own(value, 'generation'));
        const valid = user === null ? key === 'anonymous' : typeof user === 'string' && key === `user:${user}`;
        return Object.freeze({
            userPresent: valid ? user !== null : null,
            anonymous: valid ? user === null : null,
            generation,
        });
    } catch {
        return Object.freeze({ userPresent: null, anonymous: null, generation: null });
    }
}
function exact(pattern: RegExp, value: string): boolean {
    return pattern.exec(value)?.[0] === value;
}
function configuration(search: string): { runId: string; nonce: string } | null {
    const query = new URLSearchParams(search);
    const runs = query.getAll('fullAppWindowProofRun'),
        nonces = query.getAll('fullAppWindowProofNonce');
    return runs.length === 1 && nonces.length === 1 && exact(UUID, runs[0]) && exact(NONCE, nonces[0])
        ? { runId: runs[0], nonce: nonces[0] }
        : null;
}

// All readers and the nonce stay in this module. They are not returned to the
// browser proof caller, even while the explicit fixture is installed.
let fixture: {
    runId: string;
    nonce: string;
    original: ScopeFacts;
    phase: FullAppWindowEvidence['phase'];
    fenceReader: FullAppIoFence['evidence'] | null;
    graphReader: (() => FullAppWindowGraphObservation) | null;
    remount: (() => boolean) | null;
    remountUsed: boolean;
    runtimeCreations: number;
    sdkConstructions: number;
    nativeCalls: number;
    mounts: number;
    remounts: number;
    closedRenders: number;
    observation: symbol | null;
    privateSelection: FullAppWindowEvidence['privateSelection'];
    stopped: boolean;
} | null = null;

function snapshot(): FullAppWindowEvidence {
    const owned = fixture!;
    let fence: FullAppWindowEvidence['fence'] = null;
    let graph: FullAppWindowGraphObservation | null = null;
    try {
        const value = owned.fenceReader?.();
        const status = own(value, 'status'),
            counts = copyCounts(own(value, 'counts'), FENCE_COUNTS, LIMIT);
        if (own(value, 'version') === 1 && ['uninstalled', 'installed', 'failed'].includes(status as string) && counts)
            fence = Object.freeze({
                version: 1,
                status: status as ReturnType<FullAppIoFence['evidence']>['status'],
                counts,
            });
    } catch {
        /* Unobserved is null, never an invented successful zero. */
    }
    try {
        graph = owned.graphReader?.() ?? null;
    } catch {
        /* Fixed unavailable observations only. */
    }
    const rawAuth = own(graph, 'auth');
    const observedStatus = own(rawAuth, 'status');
    const status: AuthStatus = owned.stopped
        ? 'inactive'
        : AUTH_STATUSES.has(observedStatus as string)
          ? (observedStatus as AuthStatus)
          : 'unknown';
    const current = scopeFacts(own(graph, 'scope'));
    let core: FullAppWindowEvidence['core'] = null;
    let boundaries: FullAppWindowEvidence['boundaries'] = null;
    let memory: FullAppWindowEvidence['memory'] = null;
    try {
        const rawCore = own(graph, 'core'),
            platform = own(rawCore, 'platform');
        const registrationAttempts = bounded(own(rawCore, 'registrationAttempts'), 1024);
        const methodAttempts = bounded(own(rawCore, 'methodAttempts'), 1024);
        if (registrationAttempts !== null && methodAttempts !== null && (platform === 'web' || platform === 'ios'))
            core = Object.freeze({ registrationAttempts, methodAttempts, platform });
        boundaries = copyCounts(own(graph, 'boundaries'), BOUNDARY_COUNTS, 1024);
        memory = copyCounts(own(graph, 'memory'), MEMORY_COUNTS, 1024);
    } catch {
        /* Failed diagnostic readers confer no trust. */
    }
    const userPresent = own(rawAuth, 'userPresent'),
        authChecked = own(rawAuth, 'authChecked');
    const legacy = own(graph, 'legacyPermitAvailable');
    return Object.freeze({
        version: 1,
        runId: owned.runId,
        phase: owned.phase,
        fence,
        sdk: Object.freeze({
            runtimeCreations: owned.runtimeCreations,
            sdkConstructions: owned.sdkConstructions,
            nativeCalls: owned.nativeCalls,
        }),
        root: Object.freeze({ mounts: owned.mounts, remounts: owned.remounts, closedRenders: owned.closedRenders }),
        auth: Object.freeze({
            status,
            userPresent: typeof userPresent === 'boolean' ? userPresent : null,
            authChecked: typeof authChecked === 'boolean' ? authChecked : null,
        }),
        authScope: Object.freeze({
            originalUserPresent: owned.original.userPresent,
            originalAnonymous: owned.original.anonymous,
            originalGeneration: owned.original.generation,
            currentUserPresent: current.userPresent,
            currentAnonymous: current.anonymous,
            currentGeneration: current.generation,
        }),
        privateSelection: owned.stopped ? 'native-unavailable' : owned.privateSelection,
        legacyPermitAvailable: typeof legacy === 'boolean' ? legacy : null,
        core,
        boundaries,
        memory,
        lifecycle: Object.freeze({ stopped: owned.stopped }),
    });
}

/** Entry-only opt-in. No browser API is patched and no graph reader is loaded. */
export function installFullAppWindowEvidence(host: object, search: string, originalScope: unknown): void {
    const config = configuration(search);
    if (!config || fixture) return;
    const owned: NonNullable<typeof fixture> = {
        ...config,
        original: scopeFacts(originalScope),
        phase: 'starting',
        fenceReader: null,
        graphReader: null,
        remount: null,
        remountUsed: false,
        runtimeCreations: 0,
        sdkConstructions: 0,
        nativeCalls: 0,
        mounts: 0,
        remounts: 0,
        closedRenders: 0,
        observation: null,
        privateSelection: null,
        stopped: false,
    };
    const remount = Object.freeze((request: unknown): boolean => {
        if (fixture !== owned || owned.phase !== 'ready' || owned.remountUsed || !owned.remount) return false;
        try {
            if (!request || typeof request !== 'object' || Array.isArray(request)) return false;
            const keys = Reflect.ownKeys(request);
            if (keys.length !== 2 || !keys.includes('runId') || !keys.includes('nonce')) return false;
            if (own(request, 'runId') !== owned.runId || own(request, 'nonce') !== owned.nonce) return false;
            // Reserve before rendering can reenter. A refused/throwing renderer
            // cannot provide a second dispatch opportunity on this document.
            owned.remountUsed = true;
            if (!owned.remount()) return false;
            owned.remounts = Math.min(LIMIT, owned.remounts + 1);
            return true;
        } catch {
            return false;
        }
    });
    Object.defineProperties(host, {
        [FULL_APP_WINDOW_EVIDENCE_KEY]: { get: snapshot, configurable: false, enumerable: false },
        [FULL_APP_WINDOW_REMOUNT_KEY]: { value: remount, writable: false, configurable: false, enumerable: false },
    });
    fixture = owned;
}
export function observeFullAppWindowFence(reader: FullAppIoFence['evidence']): void {
    if (fixture) fixture.fenceReader = reader;
}
export function observeFullAppWindowGraph(reader: () => FullAppWindowGraphObservation): void {
    if (fixture) fixture.graphReader = reader;
}
export function setFullAppWindowRemount(remount: () => boolean): void {
    if (fixture && !fixture.remount) fixture.remount = remount;
}
export function failFullAppWindowEvidence(): void {
    if (fixture) fixture.phase = 'failed';
}
export function countFullAppRuntimeCreation(): void {
    if (fixture) fixture.runtimeCreations = Math.min(LIMIT, fixture.runtimeCreations + 1);
}
export function countFullAppSdkConstruction(): void {
    if (fixture) fixture.sdkConstructions = Math.min(LIMIT, fixture.sdkConstructions + 1);
}
export function countFullAppNativeCall(): void {
    if (fixture) fixture.nativeCalls = Math.min(LIMIT, fixture.nativeCalls + 1);
}
export function observeFullAppWindowSelection(kind: 'native-unavailable' | 'native-pilot'): void {
    if (!fixture) return;
    if (kind === 'native-unavailable') fixture.closedRenders = Math.min(LIMIT, fixture.closedRenders + 1);
    if (!fixture.stopped) fixture.privateSelection = kind;
}
/** Same effect-owned runtime/lifecycle as the root; no Auth/native calls here. */
export function observeFullAppWindowRootMount(): Readonly<{ stop(): void; detach(): void }> {
    const owned = fixture;
    if (!owned) return Object.freeze({ stop() {}, detach() {} });
    const observation = Symbol('full-app-window-observation');
    owned.observation = observation;
    owned.mounts = Math.min(LIMIT, owned.mounts + 1);
    owned.stopped = false;
    if (owned.phase !== 'failed') owned.phase = 'ready';
    const stop = () => {
        if (fixture !== owned || observation !== owned.observation) return;
        owned.stopped = true;
        owned.privateSelection = 'native-unavailable';
    };
    return Object.freeze({ stop, detach: stop });
}
