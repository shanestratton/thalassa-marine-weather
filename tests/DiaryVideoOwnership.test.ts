/**
 * A synced diary clip plays.
 *
 * resolveVideoUrl only plays a ref this account is known to own. Until
 * 2026-10-06 the only video ref ever registered was the phone's own
 * idb-video: one: the entry's media registration took its photos and voice
 * memo but not its clip, so once the drain swapped the local clip for the
 * uploaded (or Pi-parked) Storage URL, every synced clip resolved to null and
 * the player said "This video can't be loaded right now." for good, while the
 * object sat in the bucket ready to sign. Another account's path must still
 * resolve to nothing. Fictional accounts and paths only — the repo is public.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const supabase = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('../services/supabase', () => ({
    get supabase() {
        return supabase.current;
    },
}));

vi.mock('../services/DiaryRelayTransport', () => ({
    handoffDiaryToPi: vi.fn(async () => null),
    submitDiaryDirect: vi.fn(),
    cancelDiaryOnPi: vi.fn(async () => false),
    cancelDiaryDirect: vi.fn(async () => false),
    canAttemptDiaryCloudDelivery: vi.fn(() => false),
    syncPiDiaryRelayInternetPolicy: vi.fn(async () => false),
}));

vi.mock('../services/ShipLogService', () => ({
    ShipLogService: {
        resolveActiveVoyageId: vi.fn(async () => undefined),
        resolveActiveBoatId: vi.fn(async () => undefined),
    },
}));

import { DiaryService, type DiaryEntry } from '../services/DiaryService';
import { getAuthIdentityScope, setAuthIdentityScope, type AuthIdentityScope } from '../services/authIdentityScope';

const signed = vi.fn(async (path: string) => ({
    data: { signedUrl: `https://signed.example.test/${path}` },
    error: null,
}));

function mockSupabaseFor(userId: string) {
    supabase.current = {
        auth: { getUser: vi.fn(async () => ({ data: { user: { id: userId } } })) },
        storage: { from: vi.fn(() => ({ createSignedUrl: signed })) },
    };
}

const internals = DiaryService as unknown as {
    _saveCachedEntries(entries: DiaryEntry[], scope: AuthIdentityScope): void;
    _savePending(entries: DiaryEntry[], scope: AuthIdentityScope): boolean;
};

const publicUrl = (path: string) => `https://project.example.test/storage/v1/object/public/diary-video/${path}`;

function entryWith(id: string, owner: string, videoUrl: string): DiaryEntry {
    return {
        id,
        user_id: owner,
        owner_user_id: owner,
        title: 'Across the bay',
        body: 'A clean reach in a steady breeze.',
        mood: 'good',
        photos: [],
        audio_url: null,
        video_url: videoUrl,
        latitude: null,
        longitude: null,
        location_name: '',
        weather_summary: '',
        voyage_id: null,
        tags: [],
        is_public: false,
        created_at: '2026-10-06T08:00:00.000Z',
        updated_at: '2026-10-06T08:00:00.000Z',
    };
}

let run = 0;
beforeEach(() => {
    run += 1;
    localStorage.clear();
    signed.mockClear();
});

describe('diary clips that have synced', () => {
    it('a cached entry’s uploaded clip resolves to a signed URL', async () => {
        const account = `skipper-cache-${run}`;
        setAuthIdentityScope(account);
        mockSupabaseFor(account);
        const clip = publicUrl(`${account}/1759737600000.mp4`);
        internals._saveCachedEntries([entryWith('server-1', account, clip)], getAuthIdentityScope());

        expect(await DiaryService.resolveVideoUrl(clip)).toBe(
            `https://signed.example.test/${account}/1759737600000.mp4`,
        );
        expect(signed).toHaveBeenCalledWith(`${account}/1759737600000.mp4`, 3600);
    });

    it('the drain’s swap to the uploaded (or Pi-parked) URL is registered with the pending write', async () => {
        const account = `skipper-drain-${run}`;
        setAuthIdentityScope(account);
        mockSupabaseFor(account);
        const clip = publicUrl(`${account}/1759737700000.mp4`);
        expect(internals._savePending([entryWith('offline-1', account, clip)], getAuthIdentityScope())).toBe(true);

        expect(await DiaryService.resolveVideoUrl(clip)).toBe(
            `https://signed.example.test/${account}/1759737700000.mp4`,
        );
    });

    it('another account’s clip still resolves to nothing, even inside this account’s cache', async () => {
        const account = `skipper-own-${run}`;
        setAuthIdentityScope(account);
        mockSupabaseFor(account);
        const theirs = publicUrl(`someone-else-${run}/1759737800000.mp4`);
        internals._saveCachedEntries([entryWith('server-2', account, theirs)], getAuthIdentityScope());

        expect(await DiaryService.resolveVideoUrl(theirs)).toBeNull();
        expect(signed).not.toHaveBeenCalled();
    });

    it('a clip registered for one account is not playable after switching to another', async () => {
        const accountA = `skipper-a-${run}`;
        const accountB = `skipper-b-${run}`;
        setAuthIdentityScope(accountA);
        mockSupabaseFor(accountA);
        const clip = publicUrl(`${accountA}/1759737900000.mp4`);
        internals._saveCachedEntries([entryWith('server-3', accountA, clip)], getAuthIdentityScope());

        setAuthIdentityScope(accountB);
        mockSupabaseFor(accountB);
        expect(await DiaryService.resolveVideoUrl(clip)).toBeNull();
        expect(signed).not.toHaveBeenCalled();
    });
});
