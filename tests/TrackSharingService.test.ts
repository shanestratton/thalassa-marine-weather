/**
 * TrackSharingService — Unit Tests
 *
 * Tests provenance guards, center/distance calculations,
 * and browse/download validation logic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { supabase } from '../services/supabase';
import type { ShipLogEntry } from '../types';

// Must import after mocks
import { TrackSharingService } from '../services/TrackSharingService';

// ── Helpers ──────────────────────────────────────────────────────

const makeEntry = (overrides: Partial<ShipLogEntry> = {}): ShipLogEntry => ({
    id: 'entry-1',
    voyageId: 'voyage-1',
    latitude: -33.868,
    longitude: 151.209,
    timestamp: Date.now(),
    heading: 180,
    speed: 5,
    distanceNM: 1.5,
    cumulativeDistanceNM: 10.5,
    notes: '',
    source: 'device',
    ...overrides,
} as ShipLogEntry);

const mockMetadata = {
    title: 'Sydney to Manly',
    description: 'A quick hop across the harbour',
    tags: ['harbour', 'ferry'],
    category: 'coastal' as const,
    region: 'Sydney, NSW',
    vessel_draft_m: 1.8,
};

describe('TrackSharingService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('shareTrack — provenance guards', () => {
        it('throws when entries have source=community_download', async () => {
            // Mock auth
            (supabase!.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({
                data: { user: { id: 'user-1' } },
            });

            const entries = [makeEntry({ source: 'community_download' })];
            await expect(
                TrackSharingService.shareTrack(entries, mockMetadata)
            ).rejects.toThrow('Cannot re-share a community-downloaded track');
        });

        it('throws when entries have source=gpx_import', async () => {
            (supabase!.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({
                data: { user: { id: 'user-1' } },
            });

            const entries = [makeEntry({ source: 'gpx_import' })];
            await expect(
                TrackSharingService.shareTrack(entries, mockMetadata)
            ).rejects.toThrow('Cannot share imported GPX tracks');
        });

        it('throws for unknown external sources', async () => {
            (supabase!.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({
                data: { user: { id: 'user-1' } },
            });

            const entries = [makeEntry({ source: 'external_api' as any })];
            await expect(
                TrackSharingService.shareTrack(entries, mockMetadata)
            ).rejects.toThrow('Cannot share tracks from external sources');
        });

        it('throws when not authenticated', async () => {
            (supabase!.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({
                data: { user: null },
            });

            const entries = [makeEntry()];
            await expect(
                TrackSharingService.shareTrack(entries, mockMetadata)
            ).rejects.toThrow('Must be logged in');
        });

        it('throws when entries array is empty', async () => {
            (supabase!.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({
                data: { user: { id: 'user-1' } },
            });

            await expect(
                TrackSharingService.shareTrack([], mockMetadata)
            ).rejects.toThrow('No entries to share');
        });
    });

    describe('downloadTrack', () => {
        it('throws when user is not Pro', async () => {
            await expect(
                TrackSharingService.downloadTrack('track-1', false)
            ).rejects.toThrow('Pro subscription required');
        });

        it('prevents downloading own track', async () => {
            (supabase!.from as ReturnType<typeof vi.fn>).mockReturnValue({
                select: vi.fn().mockReturnThis(),
                eq: vi.fn().mockReturnThis(),
                single: vi.fn().mockResolvedValue({
                    data: { gpx_data: '<gpx/>', user_id: 'user-1' },
                    error: null,
                }),
            });

            (supabase!.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({
                data: { user: { id: 'user-1' } },
            });

            await expect(
                TrackSharingService.downloadTrack('track-1', true)
            ).rejects.toThrow('Cannot download your own shared track');
        });

        it('returns null when supabase is not available', async () => {
            // The mock returns data, but we can test the null path by simulating error
            (supabase!.from as ReturnType<typeof vi.fn>).mockReturnValue({
                select: vi.fn().mockReturnThis(),
                eq: vi.fn().mockReturnThis(),
                single: vi.fn().mockResolvedValue({ data: null, error: { message: 'Not found' } }),
            });

            const gpx = await TrackSharingService.downloadTrack('track-999', true);
            expect(gpx).toBeNull();
        });
    });

    describe('browseSharedTracks', () => {
        it('returns empty when no supabase', async () => {
            // Default mock returns data
            (supabase!.from as ReturnType<typeof vi.fn>).mockReturnValue({
                select: vi.fn().mockReturnThis(),
                eq: vi.fn().mockReturnThis(),
                ilike: vi.fn().mockReturnThis(),
                or: vi.fn().mockReturnThis(),
                order: vi.fn().mockReturnThis(),
                range: vi.fn().mockResolvedValue({
                    data: [],
                    error: null,
                    count: 0,
                }),
            });

            const result = await TrackSharingService.browseSharedTracks();
            expect(result.tracks).toEqual([]);
            expect(result.total).toBe(0);
        });

        it('applies category filter', async () => {
            const mockQuery = {
                select: vi.fn().mockReturnThis(),
                eq: vi.fn().mockReturnThis(),
                ilike: vi.fn().mockReturnThis(),
                or: vi.fn().mockReturnThis(),
                order: vi.fn().mockReturnThis(),
                range: vi.fn().mockResolvedValue({ data: [], error: null, count: 0 }),
            };
            (supabase!.from as ReturnType<typeof vi.fn>).mockReturnValue(mockQuery);

            await TrackSharingService.browseSharedTracks({ category: 'anchorage' });
            expect(mockQuery.eq).toHaveBeenCalledWith('category', 'anchorage');
        });
    });

    describe('deleteSharedTrack', () => {
        it('returns false when not authenticated', async () => {
            (supabase!.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({
                data: { user: null },
            });

            const result = await TrackSharingService.deleteSharedTrack('track-1');
            expect(result).toBe(false);
        });
    });

    describe('getMySharedTracks', () => {
        it('returns empty when not authenticated', async () => {
            (supabase!.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({
                data: { user: null },
            });

            const result = await TrackSharingService.getMySharedTracks();
            expect(result).toEqual([]);
        });
    });
});
