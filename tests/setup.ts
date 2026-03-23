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

// matchMedia (used by media query hooks and responsive components)
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

// Suppress noisy console.warn/error in tests (override per-test if needed)
// Uncomment below if tests are too noisy:
// vi.spyOn(console, 'warn').mockImplementation(() => {});
// vi.spyOn(console, 'error').mockImplementation(() => {});
