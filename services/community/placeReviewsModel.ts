/** Public catalogue identity only; never a position or an authority claim. */
export const REVIEW_TERMS = '2026-10-17';
export const DIRECTIONS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;
export const FACILITIES = [
    'water',
    'fuel',
    'toilets',
    'showers',
    'laundry',
    'provisions',
    'rubbish',
    'repairs',
] as const;
export const HOLDING = ['unknown', 'poor', 'mixed', 'good'] as const;
export const SWELL = ['unknown', 'calm', 'some', 'exposed'] as const;
export interface ReviewPlace {
    id: string;
    name: string;
    kind: 'anchorage' | 'designated_anchorage' | 'marina';
}
export interface ReviewDraft {
    holding: (typeof HOLDING)[number];
    protection: string[];
    swell: (typeof SWELL)[number];
    facilities: string[];
    notes: string;
    visited: string;
    terms_version: string;
}
export interface PlaceReview extends Omit<ReviewDraft, 'terms_version' | 'visited'> {
    visited: string | null;
    terms_version?: string;
    id: string;
    revision?: string;
    status?: string;
    updated_at: string;
    reviewed: boolean;
    photo_id?: string | null;
}
export interface ReviewQueueItem {
    id: string;
    place_id: string;
    revision: string;
    notes: string;
    status: string;
    reason: string | null;
    photo_id: string | null;
    photo_revision: string | null;
}
export const validReviewPlaceId = (id: unknown): id is string =>
    typeof id === 'string' &&
    /^(osm-(node|way|relation)[1-9]\d{0,15}|noaa:[a-fA-F0-9]{16}|gbrmpa-[A-Za-z0-9]{1,80})$/.test(id);
export function reviewPlace(value: unknown): ReviewPlace | null {
    if (!value || typeof value !== 'object') return null;
    const p = value as Record<string, unknown>;
    return validReviewPlaceId(p.id) &&
        typeof p.name === 'string' &&
        p.name.length <= 240 &&
        ['anchorage', 'designated_anchorage', 'marina'].includes(String(p.kind))
        ? { id: p.id, name: p.name, kind: p.kind as ReviewPlace['kind'] }
        : null;
}
export function validateReviewDraft(d: ReviewDraft): string | undefined {
    if (!HOLDING.includes(d.holding) || !SWELL.includes(d.swell)) return 'Choose holding and swell observations.';
    if (
        d.notes.trim().length < 1 ||
        Array.from(d.notes).length > 1200 ||
        Array.from(d.notes).some((c) => c.charCodeAt(0) < 32 && ![9, 10, 13].includes(c.charCodeAt(0)))
    )
        return 'Use 1–1200 plain text characters.';
    if (
        d.protection.length > 8 ||
        d.protection.some((x) => !(DIRECTIONS as readonly string[]).includes(x)) ||
        d.facilities.length > 8 ||
        d.facilities.some((x) => !(FACILITIES as readonly string[]).includes(x))
    )
        return 'Choose the listed directions and facilities.';
    if (
        d.visited &&
        (!/^\d{4}-\d{2}-\d{2}$/.test(d.visited) ||
            !Number.isFinite(Date.parse(d.visited)) ||
            d.visited < '2000-01-01' ||
            d.visited > '2100-01-01')
    )
        return 'Choose a valid visit date.';
    if (d.terms_version !== REVIEW_TERMS) return 'Accept the user content terms before posting.';
}
export const blankReview = (): ReviewDraft => ({
    holding: 'unknown',
    protection: [],
    swell: 'unknown',
    facilities: [],
    notes: '',
    visited: '',
    terms_version: '',
});
/** Descriptive only. Must never change weather grade, shelter geometry or route/depth proof. */
export function communityWords(reviews: readonly PlaceReview[]): string {
    return reviews.length
        ? 'Community notes available: skipper observations are indicative, may be old or incomplete, and are not clearance or anchoring advice.'
        : 'No community notes in this latest limited view; absence is not evidence of suitability.';
}
