/**
 * qldNotices — CKAN description parsing + locality gazetteer lock.
 *
 * Real strings from the live portal (2026-07-02): resource name "364 T of
 * 2026", description "02/07/2026: Mooloolah River bar — shoaling and
 * dredging\nAUS charts affected: 236…". The parse + gazetteer turn those
 * into chart-anchored, direct-PDF-linked notices.
 */
import { describe, expect, it } from 'vitest';
import { parseDescription, gazetteerMatch, groupByAnchor, type QldNotice } from '../services/qldNotices';

describe('parseDescription', () => {
    it('splits the real MSQ description shape', () => {
        const p = parseDescription(
            '02/07/2026: Mooloolah River bar — shoaling and dredging\n\nAUS charts affected: 236\nENC Cells affected: AU5MLL01',
        );
        expect(p.dateStr).toBe('02/07/2026');
        expect(p.locality).toBe('Mooloolah River bar');
        expect(p.subject).toBe('Mooloolah River bar — shoaling and dredging');
    });

    it('tolerates a description with no date prefix or dash', () => {
        const p = parseDescription('Fireworks Display Town Reach');
        expect(p.dateStr).toBe('');
        expect(p.subject).toBe('Fireworks Display Town Reach');
    });
});

describe('gazetteerMatch', () => {
    it('anchors the classic SE-QLD localities', () => {
        expect(gazetteerMatch('mooloolah river bar — shoaling')?.label).toBe('Mooloolaba');
        expect(gazetteerMatch('Eprapah Creek — beacons')?.label).toBe('Eprapah Creek');
        expect(gazetteerMatch('Wide Bay Bar crossing advice')?.label).toBe('Wide Bay Bar');
        expect(gazetteerMatch('Nerang River Chevron Island')?.label).toBe('Nerang River');
        expect(gazetteerMatch('Thursday Island wharf works')?.label).toBe('Thursday Island');
    });
    it('returns null for unknown localities (list-only, no icon)', () => {
        expect(gazetteerMatch('Some Unknown Creek dredging')).toBeNull();
    });
});

describe('groupByAnchor', () => {
    it('groups geocoded notices per locality and skips ungeocoded ones', () => {
        const mk = (label: string | undefined, num: string): QldNotice => ({
            number: num,
            subject: 's',
            dateStr: '01/07/2026',
            region: 'Brisbane',
            pdfUrl: 'https://example.org/x.pdf',
            datasetUrl: 'https://example.org/ds',
            createdMs: 0,
            ...(label ? { lat: -27, lon: 153, localityLabel: label } : {}),
        });
        const groups = groupByAnchor([mk('Mooloolaba', '1'), mk('Mooloolaba', '2'), mk(undefined, '3')]);
        expect(groups.get('Mooloolaba')?.length).toBe(2);
        expect([...groups.keys()]).toEqual(['Mooloolaba']);
    });
});
