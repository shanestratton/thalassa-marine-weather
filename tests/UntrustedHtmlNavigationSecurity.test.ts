import { describe, expect, it } from 'vitest';
import {
    buildAisTargetPopupHtml,
    buildAisVesselDetailHtml,
    finiteAisDisplayNumber,
    normaliseAisCoordinates,
    normaliseAisMmsi,
    safeAisImageUrl,
} from '../components/map/useAisStreamLayer';
import { buildTideStationPopupHtml } from '../components/map/useTideStationLayer';
import { buildMpaPopupHtml } from '../components/map/useMpaLayer';
import { localNoticePopupHtml, qldNoticeGroupPopupHtml } from '../components/map/useNoticeLayer';
import { normaliseMaritimeArticle } from '../services/MaritimeIntelService';
import { safeRssHttpsUrl } from '../supabase/functions/maritime-intel/urlSecurity';
import { safeDocumentNavigationUrl, safeExternalHttpUrl, safeImageUrl } from '../utils/safeUrl';

const ATTACK = `<img data-pwn src=x onerror="globalThis.pwned=1"><style>body{display:none}</style>`;

function parsed(markup: string): HTMLDivElement {
    const container = document.createElement('div');
    container.innerHTML = markup;
    return container;
}

describe('untrusted popup HTML', () => {
    it('renders hostile AIS transponder and registry fields only as text', () => {
        const markup = buildAisTargetPopupHtml({
            thumbnail: 'javascript:alert(1)',
            shipIcon: ATTACK,
            displayName: ATTACK,
            typeLabel: ATTACK,
            isVerified: true,
            flagCountry: ATTACK,
            navStatus: `0;position:fixed;inset:0`,
            sog: ATTACK,
            lastSeen: ATTACK,
            isPremium: true,
            needsOnDemandLookup: true,
            lookupSpinnerId: `spinner" style="position:fixed`,
            loa: Infinity,
            beam: ATTACK,
            draft: { unexpected: true },
            trustedCpaHtml: '',
            mmsi: ATTACK,
            callSign: ATTACK,
            cog: ATTACK,
            heading: ATTACK,
            destination: ATTACK,
            source: ATTACK,
            imoNumber: ATTACK,
            dataSource: ATTACK,
            hasDetails: true,
            detailBtnId: `detail" onclick="globalThis.pwned=1`,
        });
        const dom = parsed(markup);

        expect(dom.querySelector('[data-pwn]')).toBeNull();
        expect(dom.querySelector('style:not(:last-of-type)')).toBeNull();
        expect(dom.querySelector('img')).toBeNull();
        expect(markup).not.toContain('position:fixed;inset:0');
        expect(markup).not.toContain('NaN');
        expect(markup).not.toContain('Infinity');
        expect(dom.textContent).toContain('<img data-pwn');

        const colours = [...markup.matchAll(/(?:background|color):(#(?:[0-9a-f]{6}))/gi)].map((match) => match[1]);
        expect(colours.length).toBeGreaterThan(0);
        expect(colours.every((colour) => /^#[0-9a-f]{6}$/i.test(colour))).toBe(true);
    });

    it('escapes every AIS details-row value and accepts only credential-free HTTPS thumbnails', () => {
        const markup = buildAisVesselDetailHtml({
            mmsi: ATTACK,
            name: ATTACK,
            flag: ATTACK,
            flagCountry: ATTACK,
            type: ATTACK,
            callSign: ATTACK,
            imo: ATTACK,
            loa: ATTACK,
            beam: Number.NaN,
            draft: Infinity,
            thumbnail: `https://images.example.test/photo.jpg" onerror="globalThis.pwned=1`,
            destination: ATTACK,
            sog: ATTACK,
            cog: Symbol('bad-number'),
            heading: {
                valueOf: () => {
                    throw new Error('coercion denied');
                },
            },
            status: ATTACK,
            lastSeen: ATTACK,
            source: ATTACK,
            dataSource: ATTACK,
            isVerified: false,
            lat: ATTACK,
            lon: ATTACK,
        });
        const dom = parsed(markup);

        expect(dom.querySelector('[data-pwn]')).toBeNull();
        expect(dom.querySelector('[onerror]')).toBeNull();
        expect(dom.querySelector('style')).toBeNull();
        expect(dom.querySelector('img')?.getAttribute('src')).toContain('%22%20onerror=');
        expect(dom.textContent).toContain('<img data-pwn');
        expect(markup).not.toContain('NaN');
        expect(markup).not.toContain('Infinity');
    });

    it('rejects malformed AIS identifiers, coordinates, images, and numeric coercions', () => {
        expect(normaliseAisMmsi('503123456')).toBe(503123456);
        expect(normaliseAisMmsi(`503123456" onclick="pwn()`)).toBeNull();
        expect(normaliseAisMmsi(50_312_345)).toBeNull();
        expect(normaliseAisCoordinates(['153.1', '-27.4'])).toEqual([153.1, -27.4]);
        expect(normaliseAisCoordinates(['153.1', ATTACK])).toBeNull();
        expect(normaliseAisCoordinates([181, 0])).toBeNull();
        expect(finiteAisDisplayNumber(Symbol('nope'))).toBeNull();
        expect(safeAisImageUrl('https://user:pass@example.test/photo.jpg')).toBeNull();
        expect(safeAisImageUrl('data:image/svg+xml,<svg onload=alert(1)>')).toBeNull();
        expect(safeAisImageUrl('https://images.example.test/photo.jpg')).toBe('https://images.example.test/photo.jpg');
    });

    it('escapes live tide/MPA data and skips malformed numeric rows without throwing', () => {
        const tideMarkup = buildTideStationPopupHtml(
            { id: ATTACK, name: ATTACK, lat: -27, lon: 153, distance: Number.NaN },
            [
                { date: 'not-a-date', height: Number.NaN, type: 'High' },
                { date: '2026-07-24T00:00:00Z', height: 1.25, type: 'High' },
                { date: '2026-07-24T06:00:00Z', height: ATTACK as unknown as number, type: ATTACK as 'Low' },
            ],
            false,
        );
        const tideDom = parsed(tideMarkup);
        expect(tideDom.querySelector('[data-pwn]')).toBeNull();
        expect(tideDom.textContent).toContain('<img data-pwn');
        expect(tideDom.textContent).toContain('1.3m');
        expect(tideMarkup).not.toContain('NaN');

        const mpaMarkup = buildMpaPopupHtml({
            name: ATTACK,
            authority: ATTACK,
            area_km2: ATTACK as unknown as number,
        });
        const mpaDom = parsed(mpaMarkup);
        expect(mpaDom.querySelector('[data-pwn]')).toBeNull();
        expect(mpaDom.querySelector('[onerror]')).toBeNull();
    });

    it('drops scriptable notice links while preserving escaped notice text', () => {
        const local = localNoticePopupHtml({
            id: 'bad',
            title: ATTACK,
            category: 'hazard',
            lat: 0,
            lon: 0,
            radiusM: 1,
            summary: ATTACK,
            detail: ATTACK,
            sourceUrl: 'javascript:alert(1)',
            sourceName: ATTACK,
        });
        const localDom = parsed(local);
        expect(localDom.querySelector('a')).toBeNull();
        expect(localDom.querySelector('[data-pwn]')).toBeNull();

        const qld = qldNoticeGroupPopupHtml(ATTACK, [
            {
                number: ATTACK,
                subject: ATTACK,
                dateStr: ATTACK,
                region: ATTACK,
                pdfUrl: 'https://trusted.example.test@evil.example.test/file.pdf',
                datasetUrl: 'data:text/html,<script>alert(1)</script>',
                createdMs: 0,
            },
        ]);
        const qldDom = parsed(qld);
        expect(qldDom.querySelector('a')).toBeNull();
        expect(qldDom.querySelector('[data-pwn]')).toBeNull();
    });
});

describe('data-driven navigation and RSS URLs', () => {
    it('accepts only explicit safe schemes, origins, and non-scriptable data types', () => {
        expect(safeExternalHttpUrl('https://example.test/path', true)).toBe('https://example.test/path');
        expect(safeExternalHttpUrl('http://example.test/path', true)).toBeNull();
        expect(safeExternalHttpUrl('https://example.test@evil.test/path', true)).toBeNull();
        expect(safeExternalHttpUrl('java\nscript:alert(1)')).toBeNull();

        expect(safeImageUrl('data:image/png;base64,AA==')).toBe('data:image/png;base64,AA==');
        const offlineImage = `data:image/jpeg;base64,${'A'.repeat(5000)}`;
        expect(safeImageUrl(offlineImage)).toBe(offlineImage);
        expect(safeImageUrl('data:image/svg+xml,<svg onload=alert(1)>')).toBeNull();
        expect(safeDocumentNavigationUrl('data:application/pdf;base64,AA==')).toBe('data:application/pdf;base64,AA==');
        expect(safeDocumentNavigationUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
        expect(safeDocumentNavigationUrl('javascript:alert(1)')).toBeNull();
        expect(
            safeDocumentNavigationUrl(
                'blob:https://app.example.test/non/root/id',
                'https://app.example.test/app/documents',
            ),
        ).toBe('blob:https://app.example.test/non/root/id');
        expect(safeDocumentNavigationUrl('blob:https://evil.test/id', 'https://app.example.test')).toBeNull();
        expect(safeDocumentNavigationUrl('http://documents.example.test/manual.pdf')).toBeNull();
        expect(
            safeDocumentNavigationUrl('http://calypso.local:3001/manual.pdf', 'capacitor://localhost/app/documents', {
                allowLocalNetworkHttp: true,
            }),
        ).toBe('http://calypso.local:3001/manual.pdf');
    });

    it('normalises both fresh and cached maritime RSS records before UI use', () => {
        expect(
            normaliseMaritimeArticle({
                title: 'Safe title',
                snippet: 'Summary',
                url: 'javascript:alert(1)',
                image: 'data:image/svg+xml,<svg onload=alert(1)>',
                source: 'feed',
                icon: '⚓',
                publishedAt: '2026-07-24T00:00:00Z',
            }),
        ).toBeNull();

        const safe = normaliseMaritimeArticle({
            title: 'Safe title',
            snippet: 'Summary',
            url: 'https://news.example.test/story',
            image: 'https://cdn.example.test/story.jpg',
            source: 'feed',
            icon: '⚓',
            publishedAt: '2026-07-24T00:00:00Z',
        });
        expect(safe).toMatchObject({
            url: 'https://news.example.test/story',
            image: 'https://cdn.example.test/story.jpg',
        });
        expect(safeRssHttpsUrl('https://news.example.test/story')).toBe('https://news.example.test/story');
        expect(safeRssHttpsUrl('http://news.example.test/story')).toBeNull();
        expect(safeRssHttpsUrl('https://user:pass@news.example.test/story')).toBeNull();
        expect(safeRssHttpsUrl('javascript:alert(1)')).toBeNull();
    });
});
