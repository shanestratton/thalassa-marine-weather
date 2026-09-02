/**
 * Third batch of 2026-09-02 audit fixes, each confirmed by reading the code.
 * Behavioural where the unit is exported; source-pinned where it is not.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getExpiryStatus } from '../components/vessel/documents/SwipeableDocCard';
import { toLocalDateString } from '../utils/localDate';

const read = (p: string) => readFileSync(p, 'utf8');

describe('document expiry is a local calendar day', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());
    it('a document expiring today is still valid this afternoon', () => {
        // 14:00 local on 2 Sept — in UTC+10 that is 04:00Z, but even at UTC
        // midnight-plus-ten the old code had already called it expired.
        vi.setSystemTime(new Date(2026, 8, 2, 14, 0, 0));
        expect(getExpiryStatus('2026-09-02')).not.toBe('expired');
        expect(getExpiryStatus('2026-09-01')).toBe('expired');
        expect(getExpiryStatus('2026-09-20')).toBe('warning');
    });
});

describe('toLocalDateString', () => {
    it('is the LOCAL date, not the UTC one', () => {
        const d = new Date(2026, 8, 2, 7, 30); // 07:30 local, 2 Sept
        expect(toLocalDateString(d)).toBe('2026-09-02');
        expect(toLocalDateString(new Date(2026, 0, 5))).toBe('2026-01-05');
    });
});

describe('source-pinned fixes', () => {
    it('AIS guard shield has no double-click handler competing with its toggle', () => {
        // A double-tap fired onClick twice (guard on, then off) before the
        // double-click handler opened the radius picker — which has its own button.
        const src = read('components/map/AisLegend.tsx');
        expect(src).not.toMatch(/onDoubleClick=/);
        expect(src).toMatch(/onClick=\{toggleGuard\}/);
    });
    it('tide event times round to whole minutes before splitting', () => {
        expect(read('components/dashboard/tide/TideGraph.tsx')).toMatch(
            /const total = Math\.round\(event!\.time \* 60\);/,
        );
    });
    it('maintenance due dates use the local calendar day', () => {
        const src = read('components/vessel/MaintenanceHub.tsx');
        expect(src).not.toMatch(/toISOString\(\)\.split\('T'\)\[0\]/);
        expect(src).toMatch(/toLocalDateString\(/);
    });
    it('the task date field says what it is', () => {
        expect(read('components/vessel/maintenance/TaskFormModal.tsx')).toMatch(/label="First due"/);
    });
    it('"Copied!" waits for the clipboard', () => {
        expect(read('components/vessel/AvNavPage.tsx')).toMatch(/\.writeText\(cmd\)\s*\.then\(/);
    });
    it('the AIS registry lookup writes into the popup that owns the spinner', () => {
        const src = read('components/map/useAisStreamLayer.ts');
        expect(src).toMatch(/spinnerEl\?\.closest\('\.mapboxgl-popup'\)/);
    });
    it('cyclone advisory hours are labelled UTC', () => {
        expect(read('components/map/useCycloneLayer.ts')).toMatch(/PM UTC`/);
    });
    it('the intro slides point at tabs that exist', () => {
        const src = read('components/ui/OnboardingOverlay.tsx');
        for (const stale of ["tab: 'Charts'", "tab: 'Scuttlebutt'", "tab: 'Nav Station'", 'NOAA GFS'])
            expect(src).not.toContain(stale);
        const app = read('App.tsx');
        for (const tab of src.match(/tab: '([^']+)'/g)!.map((m) => m.slice(6, -1)))
            expect(app).toContain(`label="${tab}"`);
    });
    it('the four undo slots commit the pending delete before being replaced', () => {
        expect(read('components/vessel/MaintenanceHub.tsx')).toMatch(/setDeletedTask\(\(pending\) =>/);
        expect(read('components/vessel/InventoryList.tsx')).toMatch(/setDeletedItem\(\(pending\) =>/);
        expect(read('components/vessel/DocumentsHub.tsx')).toMatch(/setDeletedDoc\(\(pending\) =>/);
        const eq = read('components/vessel/EquipmentList.tsx');
        expect(eq).toMatch(/pendingDeleteRef\.current = item;/);
        expect(eq).toMatch(/LocalEquipmentService\.delete\(previous\.id\)/);
    });
    it('NMEA connect refuses an empty host or an out-of-range port with a message', () => {
        const src = read('components/vessel/NmeaPage.tsx');
        expect(src).toMatch(/portNum < 1 \|\| portNum > 65535/);
        expect(src).toMatch(/setLastError\('Enter the gateway host or IP address\.'\)/);
    });
    it('the hourly outlook shows a clock time, not an ISO string', () => {
        const src = read('components/dashboard/WeatherCharts.tsx');
        expect(src).not.toMatch(/text-white">\{item\.time\}</);
        expect(src).toMatch(/new Date\(item\.time\)\.toLocaleTimeString/);
    });
});
