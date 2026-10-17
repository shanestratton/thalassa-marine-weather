import { supabase, supabaseAnonKey, supabaseUrl } from '../supabase';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../authIdentityScope';
import { satelliteModeActive } from '../networkPolicy';
import {
    reviewPlace,
    validReviewPlaceId,
    validateReviewDraft,
    type ReviewPlace,
    type ReviewDraft,
    type PlaceReview,
    type ReviewQueueItem,
} from './placeReviewsModel';
import { recordCommunityNotes } from './communitySummary';
import { jpegSize } from '../../supabase/functions/community-review-photo/codec';
export type { ReviewPlace, ReviewDraft, PlaceReview, ReviewQueueItem };
export const REVIEWS_EVENT = 'thalassa:place-reviews';
export function openPlaceReviews(value: unknown) {
    const p = reviewPlace(value);
    if (p && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(REVIEWS_EVENT, { detail: p }));
}
export async function reviewsRequest(
    action: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
): Promise<Record<string, unknown> | null> {
    if (!supabase || satelliteModeActive() || (typeof navigator !== 'undefined' && !navigator.onLine))
        throw new Error('Community notes need a normal internet connection.');
    const scope = getAuthIdentityScope();
    const ctl = new AbortController();
    const abort = () => ctl.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) ctl.abort();
    const timer = setTimeout(abort, 10000);
    try {
        const { data, error } = await supabase
            .rpc('community_reviews', { p_action: action, p_input: input })
            .abortSignal(ctl.signal);
        if (ctl.signal.aborted || !isAuthIdentityScopeCurrent(scope)) throw new Error('Review request retired.');
        if (error) throw new Error('Community notes unavailable. Reload and try again.');
        if (data === null) return null;
        if (typeof data !== 'object' || Array.isArray(data) || JSON.stringify(data).length > 150000)
            throw new Error('Invalid review response.');
        return data as Record<string, unknown>;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
    }
}
export async function listPlaceReviews(place: ReviewPlace, signal?: AbortSignal): Promise<PlaceReview[]> {
    if (!validReviewPlaceId(place.id)) throw new Error('This place has no supported catalogue ID.');
    const result = await reviewsRequest('list', { place_id: place.id }, signal);
    if (!Array.isArray(result?.reviews) || result.reviews.length > 12) throw new Error('Invalid review response.');
    const rows = result.reviews as PlaceReview[];
    for (const row of rows) {
        if (
            !row ||
            typeof row.id !== 'string' ||
            typeof row.notes !== 'string' ||
            Array.from(row.notes).length > 1200 ||
            typeof row.holding !== 'string' ||
            typeof row.swell !== 'string' ||
            !Array.isArray(row.protection) ||
            !Array.isArray(row.facilities) ||
            row.protection.length > 8 ||
            row.facilities.length > 8 ||
            [...row.protection, ...row.facilities].some((x) => typeof x !== 'string' || x.length > 24)
        )
            throw new Error('Invalid review response.');
    }
    recordCommunityNotes(place.id, rows.length);
    return rows;
}
export async function savePlaceReview(place: ReviewPlace, draft: ReviewDraft, revision?: string, signal?: AbortSignal) {
    const issue = validateReviewDraft(draft);
    if (issue) throw new Error(issue);
    return reviewsRequest('save', { ...draft, place_id: place.id, kind: place.kind, revision }, signal);
}
export async function photoRequest(
    id: string,
    signal: AbortSignal,
    upload?: { blob: Blob; revision: string },
): Promise<Response> {
    const scope = getAuthIdentityScope();
    if (!supabase || satelliteModeActive() || !scope.userId)
        throw new Error('Sign in with a normal internet connection to view photos.');
    const {
        data: { session },
    } = await supabase.auth.getSession();
    if (!session || !isAuthIdentityScopeCurrent(scope) || signal.aborted) throw new Error('Photo request retired.');
    const headers: Record<string, string> = {
        Authorization: 'Bearer ' + session.access_token,
        apikey: supabaseAnonKey,
    };
    if (upload)
        Object.assign(headers, {
            'Content-Type': 'image/jpeg',
            'X-Review-Id': id,
            'X-Review-Revision': upload.revision,
        });
    const response = await fetch(
        supabaseUrl + '/functions/v1/community-review-photo' + (upload ? '' : '?id=' + encodeURIComponent(id)),
        { method: upload ? 'POST' : 'GET', headers, body: upload?.blob, signal, cache: 'no-store' },
    );
    if (!response.ok || signal.aborted || !isAuthIdentityScopeCurrent(scope))
        throw new Error('Photo unavailable; it may be pending, reported or removed.');
    return response;
}
/** Client resize is convenience only. The Edge independently decodes/re-encodes and strips metadata. */
export async function prepareReviewPhoto(file: File): Promise<Blob> {
    if (file.type !== 'image/jpeg' || file.size > 12 * 1024 * 1024)
        throw new Error('Choose a JPEG smaller than 12 MB.');
    const header = new Uint8Array(await file.arrayBuffer());
    const size = jpegSize(header, 16384, 20_000_000);
    const shrink = Math.min(1, 1200 / size.width, 1200 / size.height);
    const bitmap = await createImageBitmap(file, {
        resizeWidth: Math.max(1, Math.round(size.width * shrink)),
        resizeHeight: Math.max(1, Math.round(size.height * shrink)),
        resizeQuality: 'high',
    });
    try {
        const scale = Math.min(1, 1200 / bitmap.width, 1200 / bitmap.height);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Photo processing unavailable.');
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
        if (!blob || blob.size > 2_097_152) throw new Error('Choose a smaller JPEG.');
        return blob;
    } finally {
        bitmap.close();
    }
}
