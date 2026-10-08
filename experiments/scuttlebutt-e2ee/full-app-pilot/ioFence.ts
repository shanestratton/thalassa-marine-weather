/** Early trusted-entry I/O fence for the isolated full App fixture only.
 * Importing this module performs no browser/native/network work. Call the factory
 * before any App/provider import, retain its SDK fetch capability privately, and
 * abort graph loading if install() fails. This is not a security sandbox against
 * malicious same-origin JavaScript, preexisting captured transports, native
 * bridge access, or nonconfigurable Location assignment. CSP, fresh owned
 * installation and the separate native/core/package resolver gates still apply.
 */
const ORIGIN = 'https://kmtupdvwdgbhtssqqova.supabase.co';
const REFUSED = 'Full App fixture I/O refused';
const UNAVAILABLE = 'Full App fixture I/O fence unavailable';
const COUNT_LIMIT = 10000;
const COUNTERS = [
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
type Counter = (typeof COUNTERS)[number];
type RecordHost = Record<string, unknown>;
type Status = 'uninstalled' | 'installed' | 'failed';
export interface FullAppIoFence {
    install(): void;
    /** Only fixed names, bounded counts and a fixed install status. */
    evidence(): Readonly<{ version: 1; status: Status; counts: Readonly<Record<Counter, number>> }>;
    /** Private SDK dependency only. Never assign this capability to a global. */
    researchAuthFetch: typeof fetch;
}

function record(value: unknown): RecordHost | null {
    return value !== null && (typeof value === 'object' || typeof value === 'function') ? (value as RecordHost) : null;
}
function utf8Bytes(value: string): number {
    let size = 0;
    for (const character of value) {
        const point = character.codePointAt(0)!;
        size += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
    }
    return size;
}

/** Host must be a fresh trusted Window-like object. No original transports are
 * stored on it or included in evidence. Known preserved Capacitor browser aliases
 * are replaced irreversibly; a native I/O gate is a separate integration concern.
 */
export function createFullAppIoFence(host: object): Readonly<FullAppIoFence> {
    const candidate = record(host);
    if (!candidate) throw new Error(UNAVAILABLE);
    const target: RecordHost = candidate;
    let capturedFetch: typeof fetch;
    let RequestType: typeof Request;
    try {
        const preserved = target.CapacitorWebFetch;
        const original = typeof preserved === 'function' ? preserved : target.fetch;
        const request = target.Request ?? globalThis.Request;
        if (typeof original !== 'function' || typeof request !== 'function') throw new Error(UNAVAILABLE);
        capturedFetch = original as typeof fetch;
        RequestType = request as typeof Request;
    } catch {
        throw new Error(UNAVAILABLE);
    }
    const counts = Object.fromEntries(COUNTERS.map((name) => [name, 0])) as Record<Counter, number>;
    let status: Status = 'uninstalled';
    const count = (name: Counter) => {
        counts[name] = Math.min(COUNT_LIMIT, counts[name] + 1);
    };
    const refused = (name: Counter): never => {
        count(name);
        throw new Error(REFUSED);
    };
    const sync = (name: Counter) => () => refused(name);
    const asyncRefusal = (name: Counter) => () => {
        count(name);
        return Promise.reject(new Error(REFUSED));
    };
    const constructor = (name: Counter) =>
        class {
            constructor() {
                refused(name);
            }
        };
    function patch(object: RecordHost, key: string, value: unknown, critical = true) {
        try {
            Object.defineProperty(object, key, { value, writable: false, configurable: false, enumerable: true });
            const installed = Object.getOwnPropertyDescriptor(object, key);
            if (!installed || installed.value !== value || installed.configurable || installed.writable)
                throw new Error(UNAVAILABLE);
        } catch {
            count(critical ? 'patchFailures' : 'locationPatchUnavailable');
            if (critical) throw new Error(UNAVAILABLE);
        }
    }
    function closedMethods(name: Counter, methods: readonly string[], asynchronous = true): Readonly<RecordHost> {
        return Object.freeze(
            Object.fromEntries(methods.map((method) => [method, asynchronous ? asyncRefusal(name) : sync(name)])),
        );
    }
    function memoryStorage(prefix: 'localStorage' | 'sessionStorage'): Storage {
        const values = new Map<string, string>();
        let bytes = 0;
        const read = () => count(prefix === 'localStorage' ? 'localStorageReads' : 'sessionStorageReads');
        const write = () => count(prefix === 'localStorage' ? 'localStorageWrites' : 'sessionStorageWrites');
        const normalize = (value: unknown) => {
            try {
                return String(value);
            } catch {
                return refused('storageRefused');
            }
        };
        return Object.freeze({
            get length() {
                read();
                return values.size;
            },
            key(index: number) {
                read();
                return Number.isInteger(index) && index >= 0 ? ([...values.keys()][index] ?? null) : null;
            },
            getItem(key: string) {
                read();
                return values.get(normalize(key)) ?? null;
            },
            setItem(key: string, value: string) {
                write();
                const normalizedKey = normalize(key),
                    normalizedValue = normalize(value);
                // UTF-8 bytes cannot be fewer than these JS code units. Reject
                // oversized input before a full encoding/counting scan.
                if (normalizedKey.length > 1024 || normalizedValue.length > 65536) return refused('storageRefused');
                const keyBytes = utf8Bytes(normalizedKey),
                    valueBytes = utf8Bytes(normalizedValue);
                const previous = values.get(normalizedKey);
                const nextBytes =
                    bytes - (previous === undefined ? 0 : keyBytes + utf8Bytes(previous)) + keyBytes + valueBytes;
                if (
                    keyBytes > 1024 ||
                    valueBytes > 65536 ||
                    nextBytes > 262144 ||
                    (!values.has(normalizedKey) && values.size >= 128)
                )
                    return refused('storageRefused');
                values.set(normalizedKey, normalizedValue);
                bytes = nextBytes;
            },
            removeItem(key: string) {
                write();
                const normalized = normalize(key),
                    previous = values.get(normalized);
                if (previous !== undefined) {
                    bytes -= utf8Bytes(normalized) + utf8Bytes(previous);
                    values.delete(normalized);
                }
            },
            clear() {
                write();
                values.clear();
                bytes = 0;
            },
        }) as Storage;
    }
    function patchPrototype(name: string, methods: readonly string[], category: Counter, asynchronous = true) {
        const prototype = record(record(target[name])?.prototype);
        if (!prototype) return;
        for (const method of methods) patch(prototype, method, asynchronous ? asyncRefusal(category) : sync(category));
    }
    function navigationListener(event: Event) {
        try {
            if (event.type === 'submit') {
                count('navigation');
                event.preventDefault();
                return;
            }
            const node = event.target as Element | null;
            const anchor =
                node && typeof node.closest === 'function'
                    ? node.closest('a[href], area[href], a[xlink\\:href]')
                    : null;
            if (anchor && !(anchor.getAttribute('href') ?? anchor.getAttribute('xlink:href') ?? '').startsWith('#')) {
                count('navigation');
                event.preventDefault();
                event.stopImmediatePropagation();
            }
        } catch {
            count('navigation');
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    }
    function install() {
        if (status === 'installed') return;
        if (status === 'failed') throw new Error(UNAVAILABLE);
        try {
            patch(target, 'fetch', asyncRefusal('fetch'));
            for (const [key, category] of [
                ['XMLHttpRequest', 'xhr'],
                ['WebSocket', 'webSocket'],
                ['EventSource', 'eventSource'],
                ['Worker', 'worker'],
                ['SharedWorker', 'sharedWorker'],
                ['Audio', 'audio'],
                ['AudioContext', 'audio'],
                ['webkitAudioContext', 'audio'],
                ['OfflineAudioContext', 'audio'],
                ['RTCPeerConnection', 'otherNetwork'],
                ['webkitRTCPeerConnection', 'otherNetwork'],
                ['WebTransport', 'otherNetwork'],
            ] as const)
                patch(target, key, constructor(category));
            patch(target, 'CapacitorWebFetch', asyncRefusal('preservedFetch'));
            patch(target, 'CapacitorWebXMLHttpRequest', constructor('preservedXhr'));
            patch(target, 'caches', closedMethods('caches', ['open', 'match', 'has', 'delete', 'keys']));
            patch(target, 'indexedDB', closedMethods('indexedDB', ['open', 'deleteDatabase'], false));
            patch(target, 'open', sync('navigation'));
            patch(target, 'speechSynthesis', closedMethods('audio', ['speak', 'cancel', 'pause', 'resume'], false));
            patch(target, 'localStorage', memoryStorage('localStorage'));
            patch(target, 'sessionStorage', memoryStorage('sessionStorage'));
            const navigator = record(target.navigator);
            const document = record(target.document);
            if (!navigator || !document || typeof document.addEventListener !== 'function')
                throw new Error(UNAVAILABLE);
            patch(navigator, 'sendBeacon', sync('beacon'));
            patch(
                navigator,
                'serviceWorker',
                closedMethods('serviceWorker', ['register', 'getRegistration', 'getRegistrations', 'startMessages']),
            );
            patch(
                navigator,
                'geolocation',
                closedMethods('geolocation', ['getCurrentPosition', 'watchPosition', 'clearWatch'], false),
            );
            patch(navigator, 'permissions', closedMethods('permissions', ['query']));
            patch(
                navigator,
                'storage',
                closedMethods('storageManager', ['getDirectory', 'persist', 'persisted', 'estimate']),
            );
            patch(
                navigator,
                'mediaDevices',
                closedMethods('media', ['getUserMedia', 'getDisplayMedia', 'enumerateDevices']),
            );
            for (const name of ['getUserMedia', 'webkitGetUserMedia', 'mozGetUserMedia'])
                patch(navigator, name, sync('media'));
            patch(navigator, 'clipboard', closedMethods('clipboard', ['read', 'readText', 'write', 'writeText']));
            patch(navigator, 'share', asyncRefusal('navigation'));
            patch(navigator, 'canShare', sync('navigation'));
            patch(document, 'execCommand', sync('clipboard'));
            patchPrototype('HTMLFormElement', ['submit'], 'navigation', false);
            patchPrototype('HTMLMediaElement', ['play', 'setSinkId'], 'audio');
            patchPrototype('HTMLMediaElement', ['load'], 'audio', false);
            document.addEventListener.call(target.document, 'click', navigationListener, true);
            document.addEventListener.call(target.document, 'auxclick', navigationListener, true);
            document.addEventListener.call(target.document, 'contextmenu', navigationListener, true);
            document.addEventListener.call(target.document, 'submit', navigationListener, true);
            const location = record(target.location);
            if (location)
                for (const key of ['assign', 'replace', 'reload']) patch(location, key, sync('navigation'), false);
            status = 'installed';
        } catch {
            if (counts.patchFailures === 0) count('patchFailures');
            status = 'failed';
            throw new Error(UNAVAILABLE);
        }
    }
    const researchAuthFetch: typeof fetch = async (input, init) => {
        if (status !== 'installed') return refused('authRefused');
        try {
            const request = new RequestType(input, init);
            if (
                request.method !== 'POST' ||
                ![
                    ORIGIN + '/auth/v1/token?grant_type=password',
                    ORIGIN + '/auth/v1/token?grant_type=refresh_token',
                ].includes(request.url)
            )
                throw new Error(REFUSED);
            const bounded = new RequestType(request, {
                redirect: 'error',
                credentials: 'omit',
                cache: 'no-store',
                mode: 'cors',
            });
            count('authRequests');
            const response = await capturedFetch.call(host, bounded);
            if (
                !response ||
                response.redirected ||
                response.type === 'opaqueredirect' ||
                response.type === 'opaque' ||
                response.type === 'error' ||
                response.status < 200 ||
                response.status > 599 ||
                (response.status >= 300 && response.status <= 399) ||
                (response.url && response.url !== request.url)
            )
                throw new Error(REFUSED);
            count('authResponses');
            return response;
        } catch {
            // Fixed refusal only: request construction and original transport
            // errors cannot export URLs, response bodies, credentials or details.
            count('authRefused');
            throw new Error(REFUSED);
        }
    };
    return Object.freeze({
        install,
        evidence: () => Object.freeze({ version: 1 as const, status, counts: Object.freeze({ ...counts }) }),
        researchAuthFetch,
    });
}
