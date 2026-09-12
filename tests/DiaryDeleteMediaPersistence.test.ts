import { beforeEach, describe, expect, it, vi } from 'vitest';

const controls = vi.hoisted(() => ({
    client: null as unknown,
    cancel: vi.fn(async () => true),
}));
vi.mock('../services/supabase', () => ({
    get supabase() {
        return controls.client;
    },
}));
vi.mock('../services/DiaryRelayTransport', () => ({
    cancelDiaryDirect: controls.cancel,
    cancelDiaryOnPi: vi.fn(async () => false),
    canAttemptDiaryCloudDelivery: () => true,
    syncPiDiaryRelayInternetPolicy: vi.fn(async () => false),
}));

import { DiaryService } from '../services/DiaryService';
import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';

const key = (base: string) => authScopedStorageKey(`thalassa_diary_${base}`, getAuthIdentityScope());
const tombstones = () => JSON.parse(localStorage.getItem(key('deleted_v1')) ?? '[]');
const entry = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    user_id: 'u1',
    owner_user_id: 'u1',
    title: 'Diary',
    body: 'At anchor',
    mood: 'good',
    photos: [],
    audio_url: null,
    video_url: null,
    created_at: '2026-09-09T00:00:00Z',
    updated_at: '2026-09-09T00:00:00Z',
    ...extra,
});
const video = 'storage:diary-video:u1/1234567890123.mp4';

function cloud() {
    const reads = vi.fn(async () => ({ data: null as Record<string, unknown> | null, error: null as unknown }));
    const remove = vi.fn(async (_paths: string[]) => ({ error: null as unknown }));
    const references = vi.fn(async (_from: number, _to: number) => ({
        data: [] as Record<string, unknown>[],
        error: null as unknown,
    }));
    const deleted: string[] = [];
    const from = vi.fn(() => {
        const query = {
            select: () => query,
            eq: () => query,
            order: () => query,
            range: references,
            limit: async () => ({ data: [], error: null }),
            maybeSingle: reads,
            delete: () => ({
                eq: (_column: string, id: string) => ({
                    select: async () => {
                        deleted.push(id);
                        return { data: [{ id }], error: null };
                    },
                }),
            }),
        };
        return query;
    });
    controls.client = {
        from,
        auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) },
        storage: { from: () => ({ remove }) },
    };
    return { reads, remove, deleted, from, references };
}

beforeEach(() => {
    controls.client = null;
    localStorage.clear();
    setAuthIdentityScope(null);
    setAuthIdentityScope('u1');
    controls.cancel.mockReset().mockResolvedValue(true);
});

describe('durable diary media deletion', () => {
    it('loads the video from a persisted tombstone even when the Pi already removed the row', async () => {
        localStorage.setItem(key('entries_v2'), JSON.stringify([entry('video-row', { video_url: video })]));
        await DiaryService.deleteEntry('video-row');
        const api = cloud();
        await DiaryService.drainDeletedTombstones();
        expect(api.remove).toHaveBeenCalledWith(['u1/1234567890123.mp4']);
        expect(tombstones()).toEqual([]);
    });

    it('persists cold-cache media before cancellation and retains it after a Storage failure', async () => {
        await DiaryService.deleteEntry('cold-row');
        const api = cloud();
        api.reads.mockResolvedValueOnce({ data: { video_url: video, client_operation_id: 'diary_cold' }, error: null });
        controls.cancel.mockImplementationOnce(async () => {
            expect(tombstones()[0].video).toBe(video);
            return true;
        });
        api.remove.mockResolvedValueOnce({ error: { message: 'temporary Storage outage' } });
        await DiaryService.drainDeletedTombstones();
        expect(tombstones()[0].video).toBe(video);
        await DiaryService.drainDeletedTombstones();
        expect(api.remove).toHaveBeenCalledTimes(2);
        expect(tombstones()).toEqual([]);
    });

    it('cancels an offline-id draft by operation and cleans already-uploaded media without sending an invalid UUID', async () => {
        localStorage.setItem(
            key('pending_v2'),
            JSON.stringify([
                entry('offline-cloud', {
                    client_operation_id: 'diary_offline_cloud',
                    video_url: video,
                }),
            ]),
        );
        await DiaryService.deleteEntry('offline-cloud');
        const api = cloud();
        await DiaryService.drainDeletedTombstones();
        expect(controls.cancel).toHaveBeenCalledWith('diary_offline_cloud');
        expect(api.reads).not.toHaveBeenCalled();
        expect(api.deleted).toEqual([]);
        expect(api.remove).toHaveBeenCalledWith(['u1/1234567890123.mp4']);
        expect(tombstones()).toEqual([]);
    });

    it('does not treat a failed media lookup as an empty diary', async () => {
        await DiaryService.deleteEntry('lookup-error');
        const api = cloud();
        api.reads.mockResolvedValueOnce({ data: null, error: { message: 'connection lost' } });
        await DiaryService.drainDeletedTombstones();
        expect(api.deleted).toEqual([]);
        expect(api.remove).not.toHaveBeenCalled();
        expect(tombstones().map((t: { id: string }) => t.id)).toContain('lookup-error');
    });

    it('removes a queued server-id edit along with its delete fence', async () => {
        localStorage.setItem(key('pending_v2'), JSON.stringify([entry('edited-row', { video_url: video })]));
        await DiaryService.deleteEntry('edited-row');
        expect(JSON.parse(localStorage.getItem(key('pending_v2')) ?? '[]')).toEqual([]);
        expect(tombstones()[0].video).toBe(video);
    });

    it('never cleans media belonging to another account', async () => {
        localStorage.setItem(
            key('entries_v2'),
            JSON.stringify([
                entry('owner-row', {
                    video_url: 'storage:diary-video:u2/not-ours.mp4',
                    photos: ['storage:diary-photos:u2/not-ours.jpg'],
                }),
            ]),
        );
        await DiaryService.deleteEntry('owner-row');
        const api = cloud();
        await DiaryService.drainDeletedTombstones();
        expect(api.remove).not.toHaveBeenCalled();
    });

    it('keeps the saved cleanup refs if a repeated delete follows a failed cleanup', async () => {
        localStorage.setItem(key('entries_v2'), JSON.stringify([entry('repeat-row', { video_url: video })]));
        await DiaryService.deleteEntry('repeat-row');
        await DiaryService.deleteEntry('repeat-row');
        expect(tombstones()[0].video).toBe(video);
        const api = cloud();
        await DiaryService.drainDeletedTombstones();
        expect(api.remove).toHaveBeenCalledWith(['u1/1234567890123.mp4']);
    });

    it('preserves a shared video even when its surviving entry is on the second page', async () => {
        localStorage.setItem(key('entries_v2'), JSON.stringify([entry('shared-row', { video_url: video })]));
        await DiaryService.deleteEntry('shared-row');
        const api = cloud();
        api.references.mockResolvedValueOnce({
            data: Array.from({ length: 500 }, () => ({ photos: [] })),
            error: null,
        });
        api.references.mockResolvedValueOnce({ data: [{ video_url: video }], error: null });
        await DiaryService.drainDeletedTombstones();
        expect(api.references).toHaveBeenNthCalledWith(2, 500, 999);
        expect(api.remove).not.toHaveBeenCalled();
        expect(tombstones()).toEqual([]);
    });

    it('keeps cleanup pending when surviving media references cannot be read', async () => {
        localStorage.setItem(key('entries_v2'), JSON.stringify([entry('refs-error', { video_url: video })]));
        await DiaryService.deleteEntry('refs-error');
        const api = cloud();
        api.references.mockResolvedValueOnce({ data: [], error: { message: 'offline' } });
        await DiaryService.drainDeletedTombstones();
        expect(api.remove).not.toHaveBeenCalled();
        expect(tombstones()[0].video).toBe(video);
    });

    it('announces changed cloud usage only after all media cleanup succeeds', async () => {
        localStorage.setItem(key('entries_v2'), JSON.stringify([entry('event-row', { video_url: video })]));
        await DiaryService.deleteEntry('event-row');
        const onDelete = vi.fn();
        window.addEventListener('thalassa:diary-deleted', onDelete);
        try {
            const api = cloud();
            api.remove.mockResolvedValueOnce({ error: { message: 'retry' } });
            await DiaryService.drainDeletedTombstones();
            expect(onDelete).not.toHaveBeenCalled();
            await DiaryService.drainDeletedTombstones();
            expect(onDelete).toHaveBeenCalledTimes(1);
        } finally {
            window.removeEventListener('thalassa:diary-deleted', onDelete);
        }
    });
});
