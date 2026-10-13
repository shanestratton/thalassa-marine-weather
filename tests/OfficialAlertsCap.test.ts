/**
 * The shared CAP 1.2 reader (129-05, supabase/functions/_shared/cap.ts), on
 * fictional fixtures in the layouts of MeteoAlarm (Germany, France, Greece)
 * and ECCC, and on a broken document. Every language block is kept in the
 * issuer's order, the text is the issuer's byte for byte (Greek and French
 * included), and a document that does not nest is null, never half an alert.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    capValue,
    decodeEntities,
    parseAtom,
    parseCapAlert,
    parseCapCircle,
    parseCapPolygon,
    parseCapReferences,
    parseXml,
    pickInfo,
} from '../supabase/functions/_shared/cap';

const fixture = (name: string) => readFileSync(`tests/fixtures/official-alerts/${name}`, 'utf8');

describe('the XML reader', () => {
    it('reads elements by local name, attributes, CDATA and entities', () => {
        const root = parseXml(
            '<?xml version="1.0"?><!-- c --><a:root xmlns:a="x" t=\'1 &gt; 0\'><a:b>x &amp; y &#x3A9;</a:b><c><![CDATA[<raw> & ]]></c><d/></a:root>',
        )!;
        expect(root.name).toBe('root');
        expect(root.attrs.t).toBe('1 > 0');
        expect(root.children.map((c) => c.name)).toEqual(['b', 'c', 'd']);
        expect(root.children[0].text).toBe('x & y Ω');
        expect(root.children[1].text).toBe('<raw> &');
    });

    it('keeps a title holding ">" inside its quotes', () => {
        const root = parseXml('<feed><link title="a > b" href="https://x.test/"/></feed>')!;
        expect(root.children[0].attrs).toEqual({ title: 'a > b', href: 'https://x.test/' });
    });

    it('is null for a document that does not nest, has two roots or text outside the root', () => {
        expect(parseXml(fixture('malformed-cap.xml'))).toBeNull();
        expect(parseXml('<a><b></a></b>')).toBeNull();
        expect(parseXml('<a/><b/>')).toBeNull();
        expect(parseXml('junk<a/>')).toBeNull();
        expect(parseXml('<a>')).toBeNull();
        expect(parseXml('')).toBeNull();
    });

    it('never expands a DOCTYPE entity (no external fetch, no billion laughs)', () => {
        const root = parseXml(
            '<!DOCTYPE alert [<!ENTITY lol "lollollol"><!ENTITY ext SYSTEM "file:///etc/passwd">]><alert>&lol;&ext;</alert>',
        )!;
        expect(root.text).toBe('&lol;&ext;');
        expect(decodeEntities('&amp;lt;')).toBe('&lt;');
    });
});

describe('CAP 1.2 alerts', () => {
    it('Greece (MeteoAlarm): both language blocks, Greek text verbatim, the EMMA_ID zone', () => {
        const cap = parseCapAlert(fixture('meteoalarm-gr-cap.xml'))!;
        expect(cap.identifier).toBe('2.49.0.0.300.0.GR.ZZ0001');
        expect(cap.sender).toBe('emk@hnms.gr');
        expect(cap.msgType).toBe('Alert');
        expect(cap.infos.map((i) => i.language)).toEqual(['en-GB', 'el-GR']);
        const el = cap.infos[1];
        expect(el.event).toBe('Προειδοποίηση για Άνεμο');
        expect(el.headline).toBe('Κόκκινη προειδοποίηση για νησιά του Βορειοανατολικού Αιγαίου (δοκιμαστικό κείμενο)');
        expect(el.description).toBe(
            'Τοπικά άνεμοι 9 με 10 μποφόρ. Επινοημένο κείμενο για δοκιμές, όχι πραγματική προειδοποίηση.',
        );
        expect(el.instruction).toBe('Οι ναυτιλλόμενοι να παραμείνουν σε ασφαλές λιμάνι.');
        expect(el.areas[0].areaDesc).toBe('Νησιά Βορειοανατολικού Αιγαίου');
        expect(el.areas[0].geocodes).toEqual([{ valueName: 'EMMA_ID', value: 'GR914' }]);
        expect(capValue(el.parameters, 'awareness_level')).toBe('4; Red; Extreme');
        expect(el.severity).toBe('Extreme');
    });

    it('Germany and France: de-DE / fr-FR first, en-GB second, accents and umlauts intact', () => {
        const de = parseCapAlert(fixture('meteoalarm-de-cap.xml'))!;
        expect(de.infos.map((i) => i.language)).toEqual(['de-DE', 'en-GB']);
        expect(de.infos[0].event).toBe('STURMBÖEN');
        expect(de.infos[0].instruction).toContain('Äste herabstürzen');
        const fr = parseCapAlert(fixture('meteoalarm-fr-cap.xml'))!;
        expect(fr.infos[0].language).toBe('fr-FR');
        expect(fr.infos[0].senderName).toBe('Météo-France');
        expect(fr.infos[0].headline).toBe('Vigilance orange vent violent (texte d’essai)');
        expect(fr.infos[0].instruction).toBe('Limitez vos déplacements. Ne prenez pas la mer.');
    });

    it('an Update names what it replaces', () => {
        const up = parseCapAlert(fixture('meteoalarm-de-cap-2.xml'))!;
        expect(up.msgType).toBe('Update');
        expect(up.references).toEqual([
            {
                sender: 'opendata@dwd.de',
                identifier: '2.49.0.0.276.0.DWD.PVW.ZZ0000.MUL',
                sent: '2026-10-13T09:00:00+00:00',
            },
        ]);
    });

    it('ECCC: fr-CA then en-CA, polygons in GeoJSON order, text trimmed only at its ends', () => {
        const cap = parseCapAlert(fixture('eccc-alert.cap'))!;
        expect(cap.sent).toBe('2026-10-13T17:02:00-00:00');
        expect(cap.code).toEqual(['profile:CAP-CP:0.4']);
        expect(cap.infos.map((i) => i.language)).toEqual(['fr-CA', 'en-CA']);
        expect(cap.infos[1].description).toBe(
            'What: Gusts of 90 km/h. Where: fictional river sector.\n\nInvented test text.',
        );
        expect(cap.infos[1].instruction).toBeNull();
        expect(cap.infos[0].areas[0].polygons[0][0]).toEqual([-73.8, 45.4]);
        expect(cap.infos[0].areas[0].polygons[0]).toHaveLength(5);
    });

    it('is null for a broken document or one missing what CAP requires', () => {
        expect(parseCapAlert(fixture('malformed-cap.xml'))).toBeNull();
        const ok = fixture('meteoalarm-fr-cap.xml');
        expect(parseCapAlert(ok.replace('<status>Actual</status>', ''))).toBeNull();
        expect(parseCapAlert(ok.replace('<sent>2026-10-13T14:00:00+00:00</sent>', '<sent>13 Oct</sent>'))).toBeNull();
        expect(parseCapAlert(ok.replace('<msgType>Alert</msgType>', '<msgType>Shout</msgType>'))).toBeNull();
        expect(parseCapAlert(ok.replace(/<event>[^<]*<\/event>/, ''))).toBeNull();
        expect(parseCapAlert('<feed/>')).toBeNull();
    });

    it('reads polygons, circles and reference lists strictly', () => {
        expect(parseCapPolygon('38.3,-76.5 38.3,-76.2 38.6,-76.2')).toEqual([
            [-76.5, 38.3],
            [-76.2, 38.3],
            [-76.2, 38.6],
            [-76.5, 38.3],
        ]);
        expect(parseCapPolygon('91,0 0,0 1,1 91,0')).toBeNull();
        expect(parseCapPolygon('a,b c,d')).toBeNull();
        expect(parseCapCircle('35.5,139.8 12.5')).toEqual({ lat: 35.5, lon: 139.8, radiusKm: 12.5 });
        expect(parseCapCircle('35.5,139.8 0')).toBeNull();
        expect(parseCapReferences('a,b,c d,e,f broken')).toEqual([
            { sender: 'a', identifier: 'b', sent: 'c' },
            { sender: 'd', identifier: 'e', sent: 'f' },
        ]);
    });
});

describe('pickInfo: the reader’s language, else the issuer’s first', () => {
    const infos = [{ language: 'en-GB' }, { language: 'el-GR' }, { language: 'ja-JP' }, { language: 'fr-CA' }];
    it('exact, then the same language elsewhere, then the first', () => {
        expect(pickInfo(infos, 'el-GR')).toBe(infos[1]);
        expect(pickInfo(infos, 'el')).toBe(infos[1]);
        expect(pickInfo(infos, 'ja')).toBe(infos[2]);
        expect(pickInfo(infos, 'fr-FR')).toBe(infos[3]);
        expect(pickInfo(infos, 'de-DE')).toBe(infos[0]);
        expect(pickInfo(infos, null)).toBe(infos[0]);
        expect(pickInfo([], 'en')).toBeNull();
    });
});

describe('Atom', () => {
    it('reads MeteoAlarm’s entries with their CAP fields and links', () => {
        const feed = parseAtom(fixture('meteoalarm-de.atom.xml'))!;
        expect(feed.id).toBe('tag:meteoalarm.org,2021-02-19:DE');
        expect(feed.entries).toHaveLength(4);
        const e = feed.entries[0];
        expect(e.links.find((l) => l.type === 'application/cap+xml')?.href).toBe(
            'https://feeds.meteoalarm.org/api/v1/warnings/feeds-germany/00000000-0000-4000-8000-0000000de001',
        );
        expect(e.id).toContain('index_info=0&index_area=0');
        expect(e.title).toBe('Orange Wind Warning issued for Germany - Kreis Zzküste - Küste');
    });

    it('reads JMA’s PULL feed, Japanese titles included', () => {
        const feed = parseAtom(fixture('jma-extra.atom.xml'))!;
        expect(feed.entries.map((e) => e.title)).toContain('気象警報・注意報（Ｈ２７）');
    });

    it('is null for anything that is not a feed', () => {
        expect(parseAtom(fixture('eccc-alert.cap'))).toBeNull();
        expect(parseAtom('not xml')).toBeNull();
    });
});
