/**
 * Vitest Global Test Setup
 *
 * Provides mocks for:
 *  - @testing-library/jest-dom matchers
 *  - Capacitor native plugins (Preferences, Filesystem, Haptics, App, Share, PushNotifications)
 *  - Supabase client
 *  - jsdom gaps (matchMedia, IntersectionObserver, ResizeObserver, navigator.geolocation)
 *  - Web APIs (crypto.randomUUID, structuredClone)
 */

import '@testing-library/jest-dom';
import { vi } from 'vitest';

// ── Capacitor Plugins ──────────────────────────────────────────
// Mock all Capacitor native plugin imports so tests don't crash
// when running in jsdom (no native bridge available).

vi.mock('@capacitor/preferences', () => ({
    Preferences: {
        get: vi.fn().mockResolvedValue({ value: null }),
        set: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
        clear: vi.fn().mockResolvedValue(undefined),
        keys: vi.fn().mockResolvedValue({ keys: [] }),
    },
}));

vi.mock('@capacitor/filesystem', () => ({
    Filesystem: {
        writeFile: vi.fn().mockResolvedValue({ uri: 'mock://file' }),
        readFile: vi.fn().mockResolvedValue({ data: '' }),
        deleteFile: vi.fn().mockResolvedValue(undefined),
        rename: vi.fn().mockResolvedValue(undefined),
        copy: vi.fn().mockResolvedValue({ uri: 'mock://file' }),
        mkdir: vi.fn().mockResolvedValue(undefined),
        readdir: vi.fn().mockResolvedValue({ files: [] }),
        stat: vi.fn().mockResolvedValue({ type: 'file', size: 0, ctime: 0, mtime: 0, uri: '' }),
    },
    Directory: { Data: 'DATA', Documents: 'DOCUMENTS', Cache: 'CACHE' },
    Encoding: { UTF8: 'utf8' },
}));

vi.mock('@capacitor/haptics', () => ({
    Haptics: {
        impact: vi.fn().mockResolvedValue(undefined),
        notification: vi.fn().mockResolvedValue(undefined),
        vibrate: vi.fn().mockResolvedValue(undefined),
        selectionStart: vi.fn().mockResolvedValue(undefined),
        selectionChanged: vi.fn().mockResolvedValue(undefined),
        selectionEnd: vi.fn().mockResolvedValue(undefined),
    },
    ImpactStyle: { Heavy: 'HEAVY', Medium: 'MEDIUM', Light: 'LIGHT' },
    NotificationType: { Success: 'SUCCESS', Warning: 'WARNING', Error: 'ERROR' },
}));

vi.mock('@capacitor/app', () => ({
    App: {
        addListener: vi.fn().mockReturnValue({ remove: vi.fn() }),
        removeAllListeners: vi.fn(),
        getInfo: vi.fn().mockResolvedValue({ name: 'Thalassa', id: 'dev.thalassa.app', build: '1', version: '1.0.0' }),
        exitApp: vi.fn(),
    },
}));

// @capacitor/network is the one Capacitor plugin that does NOT fail loudly in
// jsdom — it ships a working web implementation. So without this stub it is the
// real plugin that loads, and mocking @capacitor/core does not prevent it: the
// package lives in node_modules and is externalized rather than inlined, so it
// binds the genuine registerPlugin regardless. The web implementation then
// wires jsdom's window 'offline' event straight into NmeaListenerService's
// socket teardown, which is live wiring no test asked for. Files that actually
// exercise the network watch mock this module themselves, and those local
// mocks still win.
vi.mock('@capacitor/network', () => ({
    Network: {
        addListener: vi.fn().mockResolvedValue({ remove: vi.fn().mockResolvedValue(undefined) }),
        getStatus: vi.fn().mockResolvedValue({ connected: true, connectionType: 'wifi' }),
        removeAllListeners: vi.fn().mockResolvedValue(undefined),
    },
}));

vi.mock('@capacitor/share', () => ({
    Share: {
        share: vi.fn().mockResolvedValue({ activityType: undefined }),
        canShare: vi.fn().mockResolvedValue({ value: true }),
    },
}));

vi.mock('@capacitor/push-notifications', () => ({
    PushNotifications: {
        addListener: vi.fn().mockReturnValue({ remove: vi.fn() }),
        removeAllListeners: vi.fn(),
        register: vi.fn().mockResolvedValue(undefined),
        requestPermissions: vi.fn().mockResolvedValue({ receive: 'granted' }),
        checkPermissions: vi.fn().mockResolvedValue({ receive: 'granted' }),
    },
}));

vi.mock('@capacitor/core', () => ({
    Capacitor: {
        isNativePlatform: vi.fn().mockReturnValue(false),
        getPlatform: vi.fn().mockReturnValue('web'),
        isPluginAvailable: vi.fn().mockReturnValue(false),
    },
    registerPlugin: vi.fn().mockReturnValue({}),
}));

// ── Supabase Client ────────────────────────────────────────────

const mockSupabaseFrom = vi.fn().mockReturnValue({
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    upsert: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    neq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: null, error: null }),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    then: vi.fn(),
});

vi.mock('../services/supabase', () => ({
    supabaseUrl: 'https://test.supabase.co',
    supabaseAnonKey: 'test-anon-key',
    supabase: {
        from: mockSupabaseFrom,
        rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
        auth: {
            getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
            getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }),
            signInWithPassword: vi.fn().mockResolvedValue({ data: { session: null, user: null }, error: null }),
            signUp: vi.fn().mockResolvedValue({ data: { session: null, user: null }, error: null }),
            signOut: vi.fn().mockResolvedValue({ error: null }),
            onAuthStateChange: vi.fn().mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } }),
        },
        storage: {
            from: vi.fn().mockReturnValue({
                upload: vi.fn().mockResolvedValue({ data: { path: 'mock-path' }, error: null }),
                getPublicUrl: vi.fn().mockReturnValue({ data: { publicUrl: 'https://mock.url/file' } }),
                download: vi.fn().mockResolvedValue({ data: new Blob(), error: null }),
            }),
        },
    },
}));

// ── jsdom Gaps ──────────────────────────────────────────────────
//
// Guarded like the localStorage block below: a suite may pin
// `@vitest-environment node` (videoTrim needs real Blob/ArrayBuffer), and
// this shared setup must not assume a window exists.

// matchMedia (used by media query hooks and responsive components)
if (typeof window !== 'undefined')
    Object.defineProperty(window, 'matchMedia', {
        writable: true,
        value: vi.fn().mockImplementation((query: string) => ({
            matches: false,
            media: query,
            onchange: null,
            addListener: vi.fn(),
            removeListener: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            dispatchEvent: vi.fn(),
        })),
    });

// IntersectionObserver (lazy loading, scroll triggers)
class MockIntersectionObserver {
    readonly root = null;
    readonly rootMargin = '';
    readonly thresholds: readonly number[] = [];
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
    takeRecords = vi.fn().mockReturnValue([]);
}
if (typeof window !== 'undefined')
    Object.defineProperty(window, 'IntersectionObserver', {
        writable: true,
        value: MockIntersectionObserver,
    });

// ResizeObserver (layout measurement)
class MockResizeObserver {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
}
if (typeof window !== 'undefined')
    Object.defineProperty(window, 'ResizeObserver', {
        writable: true,
        value: MockResizeObserver,
    });

// navigator.geolocation
Object.defineProperty(navigator, 'geolocation', {
    value: {
        getCurrentPosition: vi.fn().mockImplementation((success) =>
            success({
                coords: {
                    latitude: -33.868,
                    longitude: 151.209,
                    accuracy: 10,
                    altitude: null,
                    altitudeAccuracy: null,
                    heading: null,
                    speed: null,
                },
                timestamp: Date.now(),
            }),
        ),
        watchPosition: vi.fn().mockReturnValue(1),
        clearWatch: vi.fn(),
    },
    writable: true,
});

// crypto.randomUUID (used by ID generation)
if (!globalThis.crypto?.randomUUID) {
    Object.defineProperty(globalThis, 'crypto', {
        value: {
            ...globalThis.crypto,
            randomUUID: () => 'test-uuid-' + Math.random().toString(36).slice(2, 10),
            getRandomValues: (arr: Uint8Array) => {
                for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
                return arr;
            },
        },
        writable: true,
    });
}

// structuredClone (not available in older jsdom)
if (!globalThis.structuredClone) {
    (globalThis as any).structuredClone = <T>(val: T): T => JSON.parse(JSON.stringify(val));
}

// localStorage / sessionStorage.
//
// jsdom is active (every other DOM global is present) but under Vitest 4 it is
// not exposing Storage — a bare `expect(typeof localStorage).not.toBe('undefined')`
// fails. That is repo-wide, not one suite's problem: this app persists almost
// everything locally, so any test touching a store, a cache or an outbox died at
// `localStorage.clear()` in its own beforeEach. It is what took the diary suites
// down (18 tests, plus 13 in DiaryPublishConfirmation that could not even reach
// an assertion).
//
// A real in-memory Storage rather than a vi.fn() shim, because the code under
// test does not just call these — it round-trips through them, and several
// suites assert on what was actually persisted. getItem must return what
// setItem stored, and clear() between tests must genuinely isolate them.
//
// THE IMPLEMENTATION GOES ON Storage.prototype, not on the instance. jsdom does
// define the Storage class here (it just never hands out working instances), and
// suites patch storage failures the standard way:
//
//     vi.spyOn(Storage.prototype, 'setItem').mockImplementation(...)   // quota errors
//
// An instance carrying its own methods would shadow that prototype, the spy
// would never fire, and a test asserting "we reject when the outbox write fails"
// would silently pass through a working write instead. So each instance is
// Object.create(Storage.prototype) holding only its backing map, and every
// method resolves through the prototype where a spy can intercept it.
//
// Installed only when Storage is absent, so a future jsdom/Vitest that provides
// it natively takes over untouched.
const StorageCtor = (globalThis as any).Storage as (undefined | (new () => Storage)) | undefined;

// window-gated like everything above: Node ≥22 ships its own Storage whose
// prototype properties are non-configurable, and redefining them throws. A
// node-environment suite gets Node's storage story, not this shim.
if (typeof window !== 'undefined' && StorageCtor && typeof (globalThis as any).localStorage === 'undefined') {
    const proto = StorageCtor.prototype as Storage & { __map?: Map<string, string> };
    const mapOf = (self: any): Map<string, string> => (self.__map ??= new Map<string, string>());

    Object.defineProperties(proto, {
        getItem: {
            configurable: true,
            writable: true,
            // `?? null` — Storage returns null for a miss, never undefined, and
            // callers guard with `if (!raw) return` on exactly that.
            value: function (key: string) {
                return mapOf(this).get(String(key)) ?? null;
            },
        },
        setItem: {
            configurable: true,
            writable: true,
            // Storage stringifies both operands, which is why setItem(k, undefined)
            // reads back as the STRING "undefined" in a browser. Mirrored on purpose:
            // a stub storing the raw value would hide real JSON.parse bugs.
            value: function (key: string, value: string) {
                mapOf(this).set(String(key), String(value));
            },
        },
        removeItem: {
            configurable: true,
            writable: true,
            value: function (key: string) {
                mapOf(this).delete(String(key));
            },
        },
        clear: {
            configurable: true,
            writable: true,
            value: function () {
                mapOf(this).clear();
            },
        },
        key: {
            configurable: true,
            writable: true,
            value: function (index: number) {
                return Array.from(mapOf(this).keys())[index] ?? null;
            },
        },
        length: {
            configurable: true,
            get: function () {
                return mapOf(this).size;
            },
        },
    });

    for (const name of ['localStorage', 'sessionStorage'] as const) {
        const storage = Object.create(proto) as Storage;
        Object.defineProperty(globalThis, name, { value: storage, writable: true, configurable: true });
        // Code reaching for window.localStorage must see the SAME object, so a
        // write through one is visible through the other.
        if (typeof window !== 'undefined') {
            Object.defineProperty(window, name, { value: storage, writable: true, configurable: true });
        }
    }
}

// Suppress noisy console.warn/error in tests (override per-test if needed)
// Uncomment below if tests are too noisy:
// vi.spyOn(console, 'warn').mockImplementation(() => {});
// vi.spyOn(console, 'error').mockImplementation(() => {});
