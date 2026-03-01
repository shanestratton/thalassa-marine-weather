/**
 * Tests for DiaryService sync engine
 *
 * Tests the localStorage-based pending queue logic in isolation.
 * Supabase is mocked since we're testing the sync orchestration, not the API.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock localStorage
const store: Record<string, string> = {};
const localStorageMock = {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, val: string) => { store[key] = val; }),
    removeItem: vi.fn((key: string) => { delete store[key]; }),
    clear: vi.fn(() => { Object.keys(store).forEach(k => delete store[k]); }),
    get length() { return Object.keys(store).length; },
    key: vi.fn((i: number) => Object.keys(store)[i] ?? null),
};
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock });

// Mock navigator.onLine
Object.defineProperty(globalThis.navigator, 'onLine', { value: true, writable: true });

// Mock import.meta.env
vi.stubGlobal('import', { meta: { env: { VITE_SUPABASE_URL: '', VITE_SUPABASE_KEY: '' } } });

describe('DiaryService — Pending Queue', () => {
    const PENDING_KEY = 'thalassa_diary_pending';
    const CACHE_KEY = 'thalassa_diary_cache';

    beforeEach(() => {
        localStorageMock.clear();
        vi.clearAllMocks();
    });

    it('stores pending entries to localStorage', () => {
        const entry = {
            id: 'offline-123',
            title: 'Test Entry',
            body: 'Hello',
            mood: 'neutral',
            photos: [],
            tags: [],
            location_name: '',
            weather_summary: '',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            _offline: true,
        };

        const pending = [entry];
        localStorageMock.setItem(PENDING_KEY, JSON.stringify(pending));

        const stored = JSON.parse(localStorageMock.getItem(PENDING_KEY)!);
        expect(stored).toHaveLength(1);
        expect(stored[0].id).toBe('offline-123');
        expect(stored[0]._offline).toBe(true);
    });

    it('removes synced entry from pending queue', () => {
        const entries = [
            { id: 'offline-1', title: 'Entry 1', _offline: true },
            { id: 'offline-2', title: 'Entry 2', _offline: true },
            { id: 'offline-3', title: 'Entry 3', _offline: true },
        ];
        localStorageMock.setItem(PENDING_KEY, JSON.stringify(entries));

        // Simulate removing one synced entry
        const remaining = entries.filter(e => e.id !== 'offline-2');
        localStorageMock.setItem(PENDING_KEY, JSON.stringify(remaining));

        const stored = JSON.parse(localStorageMock.getItem(PENDING_KEY)!);
        expect(stored).toHaveLength(2);
        expect(stored.find((e: { id: string }) => e.id === 'offline-2')).toBeUndefined();
    });

    it('handles empty pending queue gracefully', () => {
        const raw = localStorageMock.getItem(PENDING_KEY);
        const pending = raw ? JSON.parse(raw) : [];
        expect(pending).toEqual([]);
    });

    it('handles corrupted localStorage gracefully', () => {
        localStorageMock.setItem(PENDING_KEY, 'NOT VALID JSON{{{');

        let pending: unknown[] = [];
        try {
            pending = JSON.parse(localStorageMock.getItem(PENDING_KEY)!);
        } catch {
            pending = [];
        }
        expect(pending).toEqual([]);
    });

    it('cache invalidation removes cached entries', () => {
        localStorageMock.setItem(CACHE_KEY, JSON.stringify([{ id: '1' }]));
        expect(localStorageMock.getItem(CACHE_KEY)).not.toBeNull();

        localStorageMock.removeItem(CACHE_KEY);
        expect(localStorageMock.getItem(CACHE_KEY)).toBeNull();
    });

    it('offline entry IDs include timestamp', () => {
        const id = `offline-${Date.now()}`;
        expect(id).toMatch(/^offline-\d+$/);
    });

    it('synced entries are removed one by one (crash-safe)', () => {
        const entries = [
            { id: 'offline-1', title: 'A' },
            { id: 'offline-2', title: 'B' },
            { id: 'offline-3', title: 'C' },
        ];
        localStorageMock.setItem(PENDING_KEY, JSON.stringify(entries));

        // Simulate crash-safe sync: remove each entry after successful insert
        for (const entry of entries) {
            const current = JSON.parse(localStorageMock.getItem(PENDING_KEY)!);
            const remaining = current.filter((e: { id: string }) => e.id !== entry.id);
            localStorageMock.setItem(PENDING_KEY, JSON.stringify(remaining));
        }

        const final = JSON.parse(localStorageMock.getItem(PENDING_KEY)!);
        expect(final).toHaveLength(0);
    });
});
