import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import jpeg from 'jpeg-js';
import { jpegSize, sanitizeReviewJpeg, readPhotoBody } from '../supabase/functions/community-review-photo/codec';
import {
    REVIEW_TERMS,
    blankReview,
    reviewPlace,
    validateReviewDraft,
    validReviewPlaceId,
    communityWords,
} from '../services/community/placeReviewsModel';
import {
    recordCommunityNotes,
    currentCommunityNote,
    retireCommunityNotes,
} from '../services/community/communitySummary';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { cachedPlaceConditions } from '../services/anchorages/PlaceConditionsService';
vi.mock('../services/weather/openMeteoProxy', () => ({ fetchOpenMeteoPoints: vi.fn() }));
const image = () => new Uint8Array(jpeg.encode({ width: 3, height: 2, data: new Uint8Array(24).fill(255) }, 80).data);
describe('community identity and descriptive-only contract', () => {
    beforeEach(() => setAuthIdentityScope('community-a'));
    it.each(['osm-node123', 'osm-way123', 'osm-relation123', 'noaa:0123456789ABCDEF', 'gbrmpa-DESIG12'])(
        'preserves original ID %s',
        (id) => expect(reviewPlace({ id, name: 'Place', kind: 'marina' })?.id).toBe(id),
    );
    it.each(['chart:private', 'osm-node0', 'osm-node123/other', 'noaa:123', 'gbrmpa-noanchor-3', 'tile-pt-1'])(
        'refuses unsupported/private/unstable identity %s',
        (id) => expect(validReviewPlaceId(id)).toBe(false),
    );
    it('requires per-post rights consent and bounds', () => {
        const d = { ...blankReview(), notes: 'Visited in settled conditions.' };
        expect(validateReviewDraft(d)).toContain('terms');
        d.terms_version = REVIEW_TERMS;
        expect(validateReviewDraft(d)).toBeUndefined();
        expect(validateReviewDraft({ ...d, notes: 'x'.repeat(1201) })).toContain('1200');
        expect(validateReviewDraft({ ...d, notes: '⚓\n'.repeat(600) })).toBeUndefined();
        expect(validateReviewDraft({ ...d, notes: '🌊'.repeat(1200) })).toBeUndefined();
        expect(validateReviewDraft({ ...d, notes: '🌊'.repeat(1201) })).toContain('1200');
        expect(validateReviewDraft({ ...d, protection: ['invalid'] })).toContain('listed');
        expect(validateReviewDraft({ ...d, facilities: ['electricity'] })).toContain('listed');
    });
    it('adds only a reason, never a suitability grade/clock', () => {
        const place = { id: 'osm-node99001', kind: 'anchorage', lat: -27, lon: 153 };
        const before = cachedPlaceConditions(place, 1000);
        recordCommunityNotes(place.id, 3, 1000);
        const after = cachedPlaceConditions(place, 1000);
        expect({ ...after, reasons: before.reasons }).toEqual(before);
        expect(after.reasons.at(-1)).toContain('do not change');
        expect(currentCommunityNote(place.id, 16000)).toBeUndefined();
    });
    it('retires on auth switch, time reversal, explicit report/delete and 128-entry eviction', () => {
        recordCommunityNotes('x', 1, 1000);
        setAuthIdentityScope('community-b');
        expect(currentCommunityNote('x', 1001)).toBeUndefined();
        recordCommunityNotes('x', 1, 1000);
        expect(currentCommunityNote('x', 999)).toBeUndefined();
        recordCommunityNotes('x', 1, 1000);
        retireCommunityNotes('x');
        expect(currentCommunityNote('x', 1001)).toBeUndefined();
        for (let i = 0; i < 129; i++) recordCommunityNotes('id' + i, 1, 1000);
        expect(currentCommunityNote('id0', 1001)).toBeUndefined();
        expect(currentCommunityNote('id128', 1001)).toContain('indicative');
        expect(communityWords([])).toContain('not evidence');
    });
});
describe('trusted JPEG pixel-only re-encoding', () => {
    it('really strips EXIF/GPS and comments using pinned jpeg-js', () => {
        const decoded = jpeg.decode(image(), { useTArray: true });
        const dirty = jpeg.encode(
            {
                ...decoded,
                exifBuffer: new Uint8Array([71, 80, 83, 45, 83, 69, 67, 82, 69, 84]),
                comments: ['private GPS metadata'],
            } as Parameters<typeof jpeg.encode>[0],
            80,
        ).data;
        expect(new TextDecoder().decode(dirty)).toContain('GPS');
        const clean = sanitizeReviewJpeg(new Uint8Array(dirty), jpeg);
        expect(new TextDecoder().decode(clean)).not.toContain('GPS');
        expect((jpeg.decode(clean, { useTArray: true }) as { exifBuffer?: Uint8Array }).exifBuffer).toBeUndefined();
        expect(jpegSize(clean)).toEqual({ width: 3, height: 2 });
    });
    it('rejects non-JPEG and oversized dimensions before decoder allocation', () => {
        const decode = vi.fn();
        const codec = { decode, encode: vi.fn() };
        expect(() => sanitizeReviewJpeg(new Uint8Array(2097153), codec)).toThrow('2 MB');
        expect(() => sanitizeReviewJpeg(new Uint8Array([1, 2, 3]), codec)).toThrow('JPEG');
        const bomb = new Uint8Array([255, 216, 255, 192, 0, 8, 8, 255, 255, 255, 255, 3]);
        expect(() => sanitizeReviewJpeg(bomb, codec)).toThrow('dimensions');
        expect(decode).not.toHaveBeenCalled();
    });
    it('never passes decoder-owned metadata to encoder', () => {
        const encode = vi.fn((_pixels: { width: number; height: number; data: Uint8Array }, _quality: number) => ({
            data: image(),
        }));
        sanitizeReviewJpeg(image(), {
            decode: () => ({ width: 3, height: 2, data: new Uint8Array(24), exifBuffer: 'private' }),
            encode,
        });
        expect(Object.keys(encode.mock.calls[0][0]).sort()).toEqual(['data', 'height', 'width']);
    });
    it('bounds streamed body even if Content-Length lies', async () => {
        const chunks = [new Uint8Array(1048576), new Uint8Array(1048577)];
        const stream = new ReadableStream({
            pull(c) {
                const b = chunks.shift();
                if (b) c.enqueue(b);
                else c.close();
            },
        });
        await expect(
            readPhotoBody(
                new Request('https://fixture.invalid', { method: 'POST', body: stream, duplex: 'half' } as RequestInit),
            ),
        ).rejects.toThrow('too large');
    });
    it('expires a stalled upload body without retaining an unbounded stream', async () => {
        vi.useFakeTimers();
        const stream = new ReadableStream<Uint8Array>({
            pull() {
                return new Promise(() => {});
            },
        });
        const result = readPhotoBody(
            new Request('https://fixture.invalid', { method: 'POST', body: stream, duplex: 'half' } as RequestInit),
        );
        const assertion = expect(result).rejects.toThrow('deadline');
        await vi.advanceTimersByTimeAsync(5001);
        await assertion;
    });
    it('rejects decoded dimension changes and oversized encoded bytes', () => {
        expect(() =>
            sanitizeReviewJpeg(image(), {
                decode: () => ({ width: 4, height: 2, data: new Uint8Array(32) }),
                encode: vi.fn(),
            }),
        ).toThrow('changed');
        expect(() =>
            sanitizeReviewJpeg(image(), {
                decode: () => ({ width: 3, height: 2, data: new Uint8Array(24) }),
                encode: () => ({ data: new Uint8Array(1048577) }),
            }),
        ).toThrow('1 MB');
    });
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});
