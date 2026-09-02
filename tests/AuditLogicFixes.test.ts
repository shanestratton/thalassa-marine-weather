/**
 * Eight logic fixes from the 2026-09-02 polish audit, each confirmed by
 * reading the code before it was touched. Pinned on the source because every
 * one is a single-token regression away from returning.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(p, 'utf8');

describe('audit logic fixes stay fixed', () => {
    it('offshore toast records the previous state before branching, so it fires once per crossing', () => {
        const src = read('hooks/useOffshoreStatus.ts');
        const record = src.indexOf('prevOffshore.current = isOffshore;');
        const branch = src.indexOf('if (isOffshore && !wasOffshore)');
        expect(record).toBeGreaterThan(-1);
        expect(branch).toBeGreaterThan(record);
    });
    it('deselecting a wind angle starts from the angles actually shown, not from []', () => {
        expect(read('components/passage/ComfortQuickConfig.tsx')).toMatch(/const cur = effectiveAngles;/);
    });
    it('pinned messages are derived from messages, never stored beside them', () => {
        const src = read('hooks/chat/useChatMessages.ts');
        expect(src).not.toMatch(/setPinnedMessages/);
        expect(src).toMatch(/const pinnedMessages = useMemo\(\(\) => messages\.filter/);
    });
    it('trip distance integrates every fix, with the mean of the two speeds', () => {
        const src = read('components/nmea/TheGlassPage.tsx');
        expect(src).toMatch(/\[state\.sog\.value, state\.sog\.freshness, state\.sog\.lastUpdated\]/);
        expect(src).toMatch(/const meanSog = \(lastSogValue\.current \+ sog\) \/ 2;/);
    });
    it('the galley stepper strips registered crew before storing the planned base', () => {
        expect(read('components/chat/GalleyCard.tsx')).toMatch(/Math\.min\(20, count - registered\)/);
    });
    it('GPX: the route is extracted before the emptiness check, and stats come from track points', () => {
        const src = read('components/vessel/GpxImportPage.tsx');
        const extract = src.indexOf('route = extractGPXRouteWaypoints(rawXml);');
        const check = src.indexOf('if (entries.length === 0 && !route)');
        expect(extract).toBeGreaterThan(-1);
        expect(check).toBeGreaterThan(extract);
        expect(src).toMatch(/const lastEntry = track\[track\.length - 1\];/);
    });
    it('the shopping list does not re-scale ingredients that are already scaled', () => {
        const src = read('components/chat/MealCalendar.tsx');
        expect(src).toMatch(/const scaled = ing\.amount;/);
        expect(src).not.toMatch(/scaleIngredient\(ing\.amount, ing\.scalable, ing\.amount/);
    });
    it('Cast Off shows a materialisation error in the select step', () => {
        const src = read('components/vessel/CastOffPanel.tsx');
        const select = src.indexOf("{step === 'select' && !loading && (");
        const alert = src.indexOf('role="alert"', select);
        const drafts = src.indexOf('{drafts.length === 0 ? (', select);
        expect(alert).toBeGreaterThan(select);
        expect(alert).toBeLessThan(drafts);
    });
});
