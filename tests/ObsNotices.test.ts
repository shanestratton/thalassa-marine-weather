import { describe, expect, it } from 'vitest';
import { selectObsNotices } from '../services/obsNotices';
import type { Notice } from '../services/NoticeToMarinersService';
const now = Date.parse('2026-10-17T00:00:00Z');
const notice = (patch: Partial<Notice> = {}): Notice => ({
    id: 'X-2026/1',
    msgYear: 2026,
    msgNumber: 1,
    navArea: 'X',
    areaLabel: 'NAVAREA X',
    subregion: '',
    issueDate: '160000Z OCT 2026',
    issueDateParsed: new Date(now - 86400000),
    authority: 'Test official issuer',
    text: 'Invented warning',
    title: 'Invented warning',
    coordinates: [{ lat: -27, lon: 179.9 }],
    status: 'A',
    ...patch,
});
const input = () => ({
    bounds: [179, -28, -179, -26] as [number, number, number, number],
    zoom: 9,
    broadcast: [notice()],
    health: [{ source: 'amsa', fetchedAt: now - 3600000 }],
    local: [],
    qld: [],
    qldFetchedAt: null,
    now,
});
describe('public notice viewport display', () => {
    it('is gated at zoom9 and respects actual wrapped/unwrapped camera copies across the dateline', () => {
        expect(selectObsNotices({ ...input(), zoom: 8.999 }).notices).toEqual([]);
        expect(selectObsNotices(input()).notices[0].lon).toBe(179.9);
        const value = selectObsNotices({ ...input(), bounds: [-181, -28, -179, -26] });
        expect(value.notices[0].lon).toBe(-180.1);
        expect(selectObsNotices({ ...input(), bounds: [0, -28, 1, -26] }).notices).toEqual([]);
        expect(selectObsNotices({ ...input(), bounds: [NaN, -28, 1, -26] }).notices).toEqual([]);
    });
    it('uses an actual text coordinate within the viewport, never a camera centre for unlocated warnings', () => {
        const result = selectObsNotices({
            ...input(),
            broadcast: [
                notice({
                    coordinates: [
                        { lat: 40, lon: 0 },
                        { lat: -27, lon: -179.9 },
                    ],
                }),
                notice({ id: 'unplaced', coordinates: [] }),
                notice({ id: 'cancelled', status: 'C' }),
            ],
        });
        expect(result.notices).toHaveLength(1);
        expect(result.notices[0]).toMatchObject({ lat: -27, lon: 180.1, approximate: false });
        expect(result.unplaced).toBe(1);
    });
    it('retains original issue strings and source-only check clocks; merged receipt age cannot make a source fresh', () => {
        expect(selectObsNotices(input()).notices[0]).toMatchObject({
            issued: '160000Z OCT 2026',
            receivedAt: now - 3600000,
        });
        expect(selectObsNotices({ ...input(), health: [] }).notices[0].receivedAt).toBeNull();
        expect(
            selectObsNotices({ ...input(), health: [{ source: 'amsa', fetchedAt: now + 1 }] }).notices[0].receivedAt,
        ).toBeNull();
    });
    it('caps marker and candidate work explicitly without claiming complete coverage', () => {
        const broadcast = Array.from({ length: 5001 }, (_, i) => notice({ id: `test:${i}` }));
        const result = selectObsNotices({ ...input(), broadcast });
        expect(result.notices).toHaveLength(40);
        expect(result.partial).toBe(true);
    });
    it('keeps locality/standing notices approximate and never substitutes the CKAN creation date for issue date', () => {
        const result = selectObsNotices({
            ...input(),
            broadcast: [],
            qld: [
                {
                    number: '1 T of 2026',
                    subject: 'Synthetic shoal',
                    dateStr: '01/10/2026',
                    region: 'Test',
                    pdfUrl: 'https://www.publications.qld.gov.au/example.pdf',
                    datasetUrl: 'https://www.publications.qld.gov.au/dataset/test',
                    lat: -27,
                    lon: 179.8,
                    createdMs: now,
                },
            ],
            qldFetchedAt: now - 7200000,
        });
        expect(result.notices[0]).toMatchObject({ issued: '01/10/2026', receivedAt: now - 7200000, approximate: true });
    });
});
