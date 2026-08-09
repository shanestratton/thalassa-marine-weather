/**
 * Turning an invisible crash into a fact.
 *
 * Shane has reported the planning screen "crashing back to the Glass page"
 * since 2026-08-01, and every attempt to chase it hit the same wall: nothing
 * in the logs. Two real causes were found and fixed anyway — auth churn
 * (d812494a) and ENC memory pressure (0a607bd3) — and it still happens on zoom.
 *
 * The logs are empty because iOS kills the WebContent process, not the app.
 * Our JavaScript dies with it, logger included, and uiStore then seeds
 * currentView from bootView — 'dashboard'. A memory kill and a cold boot are
 * indistinguishable from inside the web layer.
 *
 * These tests pin the two properties that make the next occurrence useful:
 * the record must be read correctly (a unit slip would file every kill under
 * 1970), and it must only change behaviour when the kill was JUST now.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prefs = vi.hoisted(() => ({ store: new Map<string, string>() }));
const platform = vi.hoisted(() => ({ value: 'ios' }));

vi.mock('@capacitor/preferences', () => ({
    Preferences: {
        get: async ({ key }: { key: string }) => ({ value: prefs.store.get(key) ?? null }),
        remove: async ({ key }: { key: string }) => void prefs.store.delete(key),
    },
}));
vi.mock('@capacitor/core', () => ({ Capacitor: { getPlatform: () => platform.value } }));

import { clearWebContentKill, isRecentKill, readWebContentKill } from '../services/webContentKill';

const KEY = 'thalassa.webContentKill';
const write = (record: unknown) => prefs.store.set(KEY, JSON.stringify(record));

describe('reading the native record', () => {
    beforeEach(() => {
        prefs.store.clear();
        platform.value = 'ios';
    });

    it('reads a record the Swift side wrote', async () => {
        write({ count: 3, at: 1786300000, url: 'capacitor://localhost/' });
        const r = await readWebContentKill();
        expect(r?.count).toBe(3);
        expect(r?.url).toBe('capacitor://localhost/');
    });

    it('converts seconds to milliseconds — a slip here files every kill under 1970', async () => {
        // Swift writes Date().timeIntervalSince1970, which is SECONDS.
        // new Date(seconds) lands in January 1970 and reads as a corrupt
        // record rather than as the unit mistake it is.
        write({ count: 1, at: 1786300000, url: '' });
        const r = await readWebContentKill();
        expect(r?.at.getUTCFullYear()).toBe(2026);
        expect(r?.at.getTime()).toBe(1786300000 * 1000);
    });

    it('returns null rather than throwing on junk', async () => {
        prefs.store.set(KEY, 'not json at all');
        expect(await readWebContentKill()).toBeNull();
        write({ count: 'three', at: 1786300000 });
        expect(await readWebContentKill()).toBeNull();
        write({ count: 2 }); // no timestamp
        expect(await readWebContentKill()).toBeNull();
    });

    it('returns null when there has never been a kill', async () => {
        expect(await readWebContentKill()).toBeNull();
    });

    it('is iOS-only — the record cannot exist anywhere else', async () => {
        platform.value = 'web';
        write({ count: 9, at: 1786300000 });
        expect(await readWebContentKill()).toBeNull();
    });

    it('reading does not consume — several surfaces want to know', async () => {
        write({ count: 2, at: 1786300000 });
        expect((await readWebContentKill())?.count).toBe(2);
        expect((await readWebContentKill())?.count).toBe(2);
        await clearWebContentKill();
        expect(await readWebContentKill()).toBeNull();
    });
});

describe('only a RECENT kill may change behaviour', () => {
    const at = (seconds: number) => ({ count: 1, at: new Date(seconds), url: '' });
    const NOW = 1786300000_000;

    it('counts a kill from moments ago', () => {
        expect(isRecentKill(at(NOW - 2_000), 30_000, NOW)).toBe(true);
    });

    it('ignores one from earlier in the week', () => {
        // The record survives for the life of the install. Restoring a view
        // the skipper left three days ago would be a bug of its own.
        expect(isRecentKill(at(NOW - 3 * 86_400_000), 30_000, NOW)).toBe(false);
    });

    it('ignores a record from the future rather than trusting the clock', () => {
        // Device clock moved backwards between the native write and this read.
        expect(isRecentKill(at(NOW + 60_000), 30_000, NOW)).toBe(false);
    });

    it('treats no record as no kill', () => {
        expect(isRecentKill(null)).toBe(false);
    });

    it('includes the exact boundary', () => {
        expect(isRecentKill(at(NOW - 30_000), 30_000, NOW)).toBe(true);
        expect(isRecentKill(at(NOW - 30_001), 30_000, NOW)).toBe(false);
    });
});
