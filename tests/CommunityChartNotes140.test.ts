import { describe, expect, it } from 'vitest';
import {
    CHART_PIN_CONSENT,
    NOTE_LIFETIME_MS,
    chartNoteOpacity,
    parseChartNotes,
    validNoteBBox,
    validateChartNote,
} from '../services/community/chartNotesModel';
const row = {
    id: '10000000-0000-4000-8000-000000000001',
    revision: '20000000-0000-4000-8000-000000000001',
    kind: 'hazard',
    latitude: -27,
    longitude: 153,
    message: 'Observed only.',
    observed_date: '2026-10-01',
    expires_at: '2026-10-31T00:00:00Z',
    confirms: 1,
    denies: 0,
    my_vote: null,
    mine: false,
    reviewed: false,
    photo_id: null,
};
const draft = {
    kind: 'hazard' as const,
    latitude: -27,
    longitude: 153,
    message: 'Observed only.',
    observed_date: '2026-10-01',
    terms_version: '2026-10-17',
    public_consent: CHART_PIN_CONSENT,
};
const payload = (notes: unknown[] = [row]) => ({ notes, server_now: '2026-10-17T00:00:00Z', truncated: false });
describe('unofficial bounded chart observation model', () => {
    it('requires separate explicit pin consent, rights and a real recent UTC date', () => {
        expect(validateChartNote(draft, '2026-10-17')).toBeUndefined();
        expect(validateChartNote({ ...draft, public_consent: '' }, '2026-10-17')).toContain('publish');
        expect(validateChartNote({ ...draft, terms_version: '' }, '2026-10-17')).toContain('terms');
        for (const observed_date of ['2026-10-18', '2026-09-17', '2026-02-30'])
            expect(validateChartNote({ ...draft, observed_date }, '2026-10-17')).toContain('date');
        expect(validateChartNote({ ...draft, message: '🌊'.repeat(1200) }, '2026-10-17')).toBeUndefined();
        expect(validateChartNote({ ...draft, message: '🌊'.repeat(1201) }, '2026-10-17')).toContain('1200');
        expect(validateChartNote({ ...draft, message: 'control\0' }, '2026-10-17')).toContain('plain');
    });
    it.each([
        [NaN, 0, 1, 1],
        [0, 0, 5, 1],
        [1, 0, 0, 1],
        [179, 0, -179, 1],
        [0, -86, 1, 0],
    ])('refuses invalid, oversized or wrapped view %j', (...b) => expect(validNoteBBox(b)).toBe(false));
    it('bounds the full view and strips all author/vessel/path extras', () => {
        expect(validNoteBBox([152, -28, 154, -26])).toBe(true);
        const parsed = parseChartNotes(
            payload([{ ...row, owner_id: 'secret', vessel_id: 'secret', object_path: 'private', status: 'approved' }]),
        );
        expect(parsed.notes[0]).toEqual(row);
        expect(Object.isFrozen(parsed.notes)).toBe(true);
        expect(Object.isFrozen(parsed.notes[0])).toBe(true);
        expect(() => parseChartNotes(payload(Array(151).fill(row)))).toThrow('Invalid');
    });
    it('fades by observation date and has a fixed 30-day cutoff regardless of vote count', () => {
        const start = Date.parse(row.observed_date);
        expect(chartNoteOpacity(row, start + 7 * 86400000)).toBe(1);
        expect(chartNoteOpacity(row, start + 20 * 86400000)).toBeLessThan(1);
        expect(chartNoteOpacity(row, start + NOTE_LIFETIME_MS)).toBe(0);
        expect(chartNoteOpacity(row, start - 1)).toBe(0);
        expect(parseChartNotes({ ...payload(), server_now: row.expires_at }).notes).toEqual([]);
    });
    it.each([
        { expires_at: '2026-11-01T00:00:00Z' },
        { confirms: 2001 },
        { confirms: 1.5 },
        { my_vote: 'verified' },
        { photo_id: 'private/path' },
        { latitude: Infinity },
        { observed_date: '2026-11-01' },
    ])('refuses malformed public facts %j', (extra) =>
        expect(() => parseChartNotes(payload([{ ...row, ...extra }]))).toThrow('Invalid'),
    );
});
