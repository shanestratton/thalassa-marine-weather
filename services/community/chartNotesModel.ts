/** Unofficial observations for display only. No navigation inputs. */
export const CHART_NOTE_TYPES = ['moved-mark', 'new-mooring', 'hazard', 'other'] as const;
export const CHART_PIN_CONSENT = 'publish-pin-and-note-v1';
export const NOTE_LIFETIME_MS = 30 * 86_400_000;
export const NOTE_FADE_START_MS = 7 * 86_400_000;
export const NOTE_LEASE_MS = 15_000;
export const NOTE_WINDOW_LIMIT = 150;
export type ChartNoteType = (typeof CHART_NOTE_TYPES)[number];
export type ChartVote = 'confirm' | 'deny';
export interface ChartNote {
    readonly id: string;
    readonly revision: string;
    readonly kind: ChartNoteType;
    readonly latitude: number;
    readonly longitude: number;
    readonly message: string;
    readonly observed_date: string;
    readonly expires_at: string;
    readonly confirms: number;
    readonly denies: number;
    readonly my_vote: ChartVote | null;
    readonly mine: boolean;
    readonly reviewed: boolean;
    readonly photo_id: string | null;
}
export interface ChartNoteDraft {
    kind: ChartNoteType;
    latitude: number;
    longitude: number;
    message: string;
    observed_date: string;
    terms_version: string;
    public_consent: string;
}
export type ChartNoteBBox = readonly [west: number, south: number, east: number, north: number];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const finite = (n: unknown, lo: number, hi: number): n is number =>
    typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi;
export const isChartNoteId = (v: unknown): v is string => typeof v === 'string' && uuid.test(v);
export function validNoteBBox(b: unknown): b is ChartNoteBBox {
    return (
        Array.isArray(b) &&
        b.length === 4 &&
        finite(b[0], -180, 180) &&
        finite(b[2], -180, 180) &&
        finite(b[1], -85, 85) &&
        finite(b[3], -85, 85) &&
        b[2] > b[0] &&
        b[3] > b[1] &&
        b[2] - b[0] <= 4 &&
        b[3] - b[1] <= 4
    );
}
export function validateChartNote(d: ChartNoteDraft, utcToday: string): string | undefined {
    if (!CHART_NOTE_TYPES.includes(d.kind) || !finite(d.latitude, -85, 85) || !finite(d.longitude, -180, 180))
        return 'Choose a valid observation pin and type.';
    if (
        !d.message.trim() ||
        Array.from(d.message).length > 1200 ||
        Array.from(d.message).some((c) => c.charCodeAt(0) < 32 && ![9, 10, 13].includes(c.charCodeAt(0)))
    )
        return 'Use 1–1200 plain text characters.';
    const observed = Date.parse(d.observed_date),
        today = Date.parse(utcToday);
    if (
        !/^\d{4}-\d{2}-\d{2}$/.test(d.observed_date) ||
        !Number.isFinite(observed) ||
        !Number.isFinite(today) ||
        new Date(observed).toISOString().slice(0, 10) !== d.observed_date ||
        observed > today ||
        observed <= today - NOTE_LIFETIME_MS
    )
        return 'Choose an observation date within the last 30 days.';
    if (d.terms_version !== '2026-10-17' || d.public_consent !== CHART_PIN_CONSENT)
        return 'Accept the content terms and explicitly publish this pin and note.';
}
export function chartNoteOpacity(note: Pick<ChartNote, 'observed_date' | 'expires_at'>, serverNow: number): number {
    const observed = Date.parse(note.observed_date),
        expiry = Date.parse(note.expires_at);
    if (
        !Number.isFinite(serverNow) ||
        !Number.isFinite(observed) ||
        !Number.isFinite(expiry) ||
        serverNow < observed ||
        serverNow >= expiry
    )
        return 0;
    const age = serverNow - observed;
    return age <= NOTE_FADE_START_MS
        ? 1
        : Math.max(0.3, 1 - (0.7 * (age - NOTE_FADE_START_MS)) / (NOTE_LIFETIME_MS - NOTE_FADE_START_MS));
}
export interface ParsedChartNotes {
    readonly notes: readonly ChartNote[];
    readonly serverNow: number;
    readonly truncated: boolean;
}
/** Exact public fields only; account/vessel/path properties never survive parsing. */
export function parseChartNotes(value: unknown): ParsedChartNotes {
    if (!value || typeof value !== 'object') throw Error('Community notes unavailable.');
    const data = value as Record<string, unknown>;
    const serverNow = typeof data.server_now === 'string' ? Date.parse(data.server_now) : NaN;
    if (
        !Number.isFinite(serverNow) ||
        !Array.isArray(data.notes) ||
        data.notes.length > NOTE_WINDOW_LIMIT ||
        typeof data.truncated !== 'boolean'
    )
        throw Error('Invalid community note response.');
    const notes = data.notes
        .map((raw) => {
            if (!raw || typeof raw !== 'object') throw Error('Invalid community note.');
            const n = raw as Record<string, unknown>;
            if (
                !isChartNoteId(n.id) ||
                !isChartNoteId(n.revision) ||
                !(CHART_NOTE_TYPES as readonly unknown[]).includes(n.kind) ||
                !finite(n.latitude, -85, 85) ||
                !finite(n.longitude, -180, 180) ||
                typeof n.message !== 'string' ||
                !n.message.trim() ||
                Array.from(n.message).length > 1200 ||
                typeof n.observed_date !== 'string' ||
                !/^\d{4}-\d{2}-\d{2}$/.test(n.observed_date) ||
                typeof n.expires_at !== 'string' ||
                !finite(n.confirms, 0, 2000) ||
                !Number.isInteger(n.confirms) ||
                !finite(n.denies, 0, 2000) ||
                !Number.isInteger(n.denies) ||
                n.confirms + n.denies > 2000 ||
                ![null, 'confirm', 'deny'].includes(n.my_vote as string | null) ||
                typeof n.mine !== 'boolean' ||
                typeof n.reviewed !== 'boolean' ||
                !(n.photo_id === null || isChartNoteId(n.photo_id))
            )
                throw Error('Invalid community note.');
            const observed = Date.parse(n.observed_date),
                expires = Date.parse(n.expires_at);
            if (
                !Number.isFinite(observed) ||
                !Number.isFinite(expires) ||
                new Date(observed).toISOString().slice(0, 10) !== n.observed_date ||
                expires - observed !== NOTE_LIFETIME_MS ||
                observed > serverNow
            )
                throw Error('Invalid community note clock.');
            return Object.freeze({
                id: n.id,
                revision: n.revision,
                kind: n.kind as ChartNoteType,
                latitude: n.latitude,
                longitude: n.longitude,
                message: n.message,
                observed_date: n.observed_date,
                expires_at: n.expires_at,
                confirms: n.confirms,
                denies: n.denies,
                my_vote: n.my_vote as ChartVote | null,
                mine: n.mine,
                reviewed: n.reviewed,
                photo_id: n.photo_id as string | null,
            });
        })
        .filter((note) => Date.parse(note.expires_at) > serverNow);
    return Object.freeze({ notes: Object.freeze(notes), serverNow, truncated: data.truncated });
}
