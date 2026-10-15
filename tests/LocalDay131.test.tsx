/**
 * Due and expiry dates are the skipper's local day (131-B11; binder audit
 * STORES-07, EQ-2, MAINT-07, DOC-5, GAL-05).
 *
 * A day kept in a timestamp column comes back from the server as its UTC
 * midnight, '2026-11-01T00:00:00+00:00', and new Date() makes that, and a
 * bare '2026-11-01', the 31st of October anywhere west of Greenwich. One
 * helper, utils/localDate's readLocalDay, now reads both as 1 November on the
 * phone, for the screens and the binder PDFs alike; a departure or a logged
 * service, which are moments, keep the local day they fall on.
 *
 * Every case runs on a phone in Los Angeles and one in Brisbane: Node re-reads
 * process.env.TZ when it is assigned, so CI on UTC still catches a revert.
 * Fictional stores, papers and gear only.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { act, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EquipmentItem, InventoryItem, MaintenanceTask } from '../types';

vi.mock('../services/vessel/DocumentSyncService', () => ({
    DocumentSyncService: { openDownload: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

import { addLocalDays, localDayString, localDaysUntil, readLocalDay, toLocalDateString } from '../utils/localDate';
import { formatDisplayDate } from '../utils/displayDate';
import { pdfDaysUntil, pdfShortDate } from '../services/pdf/pdfDates';
import { calculateStatus, calendarDaysUntil } from '../services/MaintenanceService';
import { calculateMealDays } from '../services/MealPlanService';
import { useMaintenanceForm } from '../hooks/useMaintenanceForm';
import { getExpiryStatus } from '../components/vessel/documents/SwipeableDocCard';
import { warrantyInForce } from '../components/vessel/equipment/SwipeableEquipmentCard';
import { EquipmentDetail } from '../components/vessel/equipment/EquipmentDetail';
import { SwipeableInventoryCard } from '../components/vessel/inventory/SwipeableInventoryCard';

const ZONES = ['America/Los_Angeles', 'Australia/Brisbane'] as const;

/** 1 November 2026 as the server hands back a day kept in a timestamp column. */
const SYNCED = '2026-11-01T00:00:00+00:00';
/** The same day as the phone saved it, and as a DATE column returns it. */
const BARE = '2026-11-01';

/** [year, month (0-based), day, hour] of a local Date, or null. */
const parts = (date: Date | null) => date && [date.getFullYear(), date.getMonth(), date.getDate(), date.getHours()];
const NOV_1 = [2026, 10, 1, 0];

describe.each(ZONES)('on a phone in %s', (zone) => {
    const was = process.env.TZ;
    beforeEach(() => {
        process.env.TZ = zone;
        vi.useFakeTimers({ toFake: ['Date'] });
    });
    afterEach(() => {
        vi.useRealTimers();
        if (was === undefined) delete process.env.TZ;
        else process.env.TZ = was;
    });

    /** A local moment on this phone's clock (built after TZ is set). */
    const local = (month: number, day: number, hour = 0, minute = 0) => new Date(2026, month - 1, day, hour, minute);

    describe('readLocalDay', () => {
        it('reads a bare day and its synced UTC midnight, in every spelling, as that local day', () => {
            for (const value of [
                BARE,
                SYNCED,
                '2026-11-01T00:00:00Z',
                '2026-11-01T00:00:00.000Z',
                '2026-11-01 00:00:00+00',
                '2026-11-01T00:00:00.000000+00:00',
            ]) {
                expect(parts(readLocalDay(value)), value).toEqual(NOV_1);
            }
            expect(localDayString(SYNCED)).toBe(BARE);
        });

        it('keeps a moment on the local day it falls on', () => {
            // 07:00 Saturday in Brisbane is still Friday in UTC and in Los Angeles.
            const departs = '2026-10-16T21:00:00Z';
            expect(localDayString(departs)).toBe(zone === 'Australia/Brisbane' ? '2026-10-17' : '2026-10-16');
            // What the server's log_service writes: now() + 30 days, to the microsecond.
            const due = '2026-11-13T22:00:00.123456+00:00';
            expect(localDayString(due)).toBe(zone === 'Australia/Brisbane' ? '2026-11-14' : '2026-11-13');
            // A Date is a moment too.
            expect(parts(readLocalDay(local(11, 1, 18, 30)))).toEqual(NOV_1);
        });

        it('gives null, or an empty input, for no date or an unreadable one', () => {
            for (const value of [null, undefined, '', 'not a date', '2026-02-30', '2026-13-01']) {
                expect(readLocalDay(value), String(value)).toBeNull();
                expect(localDayString(value)).toBe('');
                expect(localDaysUntil(value)).toBeNull();
            }
            expect(readLocalDay(new Date(Number.NaN))).toBeNull();
        });

        it('counts and steps whole calendar days across a daylight-saving change', () => {
            // The US clocks go back at 02:00 on 1 November 2026, the Americas'
            // 25-hour day; Brisbane has none, and must count the same.
            const lateOnHalloween = local(10, 31, 23, 30);
            expect(localDaysUntil('2026-11-02', lateOnHalloween)).toBe(2);
            expect(localDaysUntil(SYNCED, lateOnHalloween)).toBe(1);
            expect(localDaysUntil('2026-10-31', lateOnHalloween)).toBe(0);
            expect(toLocalDateString(addLocalDays(lateOnHalloween, 1))).toBe(BARE);
            expect(toLocalDateString(addLocalDays(lateOnHalloween, 2))).toBe('2026-11-02');
            // And forward on 8 March 2027, the 23-hour day.
            expect(toLocalDateString(addLocalDays(new Date(2027, 2, 7, 23, 30), 1))).toBe('2027-03-08');
        });
    });

    describe('the screens and the binder PDFs read a synced day as the same day', () => {
        it('shows 1 November, on screen and on paper', () => {
            expect(formatDisplayDate(SYNCED)).toBe('Sun 1 Nov 2026');
            expect(formatDisplayDate(BARE, { weekday: false })).toBe('1 Nov 2026');
            expect(pdfShortDate(SYNCED, 'en-GB')).toBe('1 Nov 2026');
            expect(pdfShortDate(SYNCED, 'en-US')).toBe('Nov 1, 2026');
            const evening = local(10, 30, 18);
            expect(pdfDaysUntil(SYNCED, evening)).toBe(2);
            expect(calendarDaysUntil(SYNCED, evening)).toBe(2);
        });

        it('Maintenance: a task due on the synced 1 November is due today on the 1st, not overdue', () => {
            vi.setSystemTime(local(11, 1, 18));
            const task: MaintenanceTask = {
                id: 't-impeller',
                user_id: 'skipper-1',
                title: 'Raw-water impeller',
                description: null,
                category: 'Engine',
                trigger_type: 'monthly',
                interval_value: 30,
                next_due_date: SYNCED,
                next_due_hours: null,
                last_completed: null,
                is_active: true,
                created_at: '2026-10-01T00:00:00.000Z',
                updated_at: '2026-10-01T00:00:00.000Z',
            };
            const status = calculateStatus(task, 0);
            expect(status.statusLabel).toBe('Due today');
            expect(status.daysRemaining).toBe(0);
            expect(calculateStatus({ ...task, next_due_date: BARE }, 0).statusLabel).toBe('Due today');
        });

        it('Documents: a paper expiring on the synced 1 November is valid all that day, expired the next', () => {
            vi.setSystemTime(local(11, 1, 18));
            expect(getExpiryStatus(SYNCED)).toBe('warning');
            expect(getExpiryStatus(BARE)).toBe('warning');
            expect(getExpiryStatus('2026-12-01T00:00:00+00:00')).toBe('valid');
            vi.setSystemTime(local(11, 2, 8));
            expect(getExpiryStatus(SYNCED)).toBe('expired');
            expect(getExpiryStatus(null)).toBe('none');
            expect(getExpiryStatus('not a date')).toBe('none');
        });

        it('Equipment: a warranty ending on the synced 1 November is in force all that day', () => {
            vi.setSystemTime(local(11, 1, 18));
            expect(warrantyInForce(SYNCED)).toBe(true);
            expect(warrantyInForce(BARE)).toBe(true);
            vi.setSystemTime(local(11, 2, 8));
            expect(warrantyInForce(SYNCED)).toBe(false);
            expect(warrantyInForce(null)).toBeNull();
        });
    });

    describe('Stores card', () => {
        const flares = (expiry: string): InventoryItem =>
            ({
                id: 's-flares',
                user_id: 'skipper-1',
                barcode: null,
                item_name: 'Handheld flares',
                description: null,
                category: 'Safety',
                quantity: 4,
                min_quantity: 0,
                unit: 'whole',
                location_zone: 'Cockpit locker',
                location_specific: null,
                expiry_date: expiry,
                created_at: '2026-10-01T00:00:00.000Z',
                updated_at: '2026-10-01T00:00:00.000Z',
            }) as InventoryItem;

        it.each([BARE, SYNCED])('counts down to %s in local days and shows that day', (expiry) => {
            // 20:00 on Friday 30 October: two days to go, wherever the phone is.
            vi.setSystemTime(local(10, 30, 20));
            render(<SwipeableInventoryCard item={flares(expiry)} isExpanded onTap={vi.fn()} units="metric" />);
            expect(screen.getByText('Expires in 2 days')).toBeInTheDocument();
            expect(screen.getByText('1 Nov 2026')).toBeInTheDocument();
        });

        it('reads Expired from the day itself, as the Stores PDF reds it', () => {
            vi.setSystemTime(local(11, 1, 8));
            render(<SwipeableInventoryCard item={flares(SYNCED)} isExpanded={false} onTap={vi.fn()} units="metric" />);
            expect(screen.getByText('Expired')).toBeInTheDocument();
        });
    });

    describe('Equipment detail', () => {
        it('shows the synced install and warranty days as they were entered', () => {
            vi.setSystemTime(local(10, 30, 20));
            const watermaker: EquipmentItem = {
                id: 'e-wm',
                user_id: 'skipper-1',
                equipment_name: 'Watermaker',
                category: 'Plumbing',
                make: 'Fictional Pumps',
                model: 'WM-40',
                serial_number: 'WM-0001',
                installation_date: '2024-03-01T00:00:00+00:00',
                warranty_expiry: SYNCED,
                manual_uri: null,
                notes: null,
                created_at: '2026-10-01T00:00:00.000Z',
                updated_at: '2026-10-01T00:00:00.000Z',
            };
            render(<EquipmentDetail item={watermaker} onBack={vi.fn()} onEdit={vi.fn()} />);
            expect(screen.getByText('1 Mar 2024')).toBeInTheDocument();
            expect(screen.getByText('Active')).toBeInTheDocument();
            expect(screen.getByText('Expires 1 Nov 2026')).toBeInTheDocument();
        });
    });

    describe("Maintenance 'First due'", () => {
        it("starts on today's local day when the page opens, and again on reset", () => {
            // 18:00 Friday 9 October: Saturday in UTC on an American phone.
            vi.setSystemTime(local(10, 9, 18));
            const { result } = renderHook(() => useMaintenanceForm());
            expect(result.current.form.dueDate).toBe('2026-10-09');
            // 07:00 next morning: Friday still, in UTC, on a Queensland phone.
            vi.setSystemTime(local(10, 10, 7));
            act(() => result.current.setField('title', 'Check bilge pump'));
            act(() => result.current.reset());
            expect(result.current.form).toMatchObject({ title: '', dueDate: '2026-10-10' });
        });

        it('moves an untouched day on to today as Add opens, and keeps the rest of a draft', () => {
            vi.setSystemTime(local(10, 9, 21));
            const { result } = renderHook(() => useMaintenanceForm());
            act(() => result.current.openForAdd());
            act(() => result.current.setField('title', 'Check bilge pump'));
            // The sheet is closed unsaved, and the page stays open overnight.
            vi.setSystemTime(local(10, 10, 7));
            act(() => result.current.openForAdd());
            expect(result.current.form).toMatchObject({ title: 'Check bilge pump', dueDate: '2026-10-10' });
        });

        it('keeps a day the skipper picked in a draft', () => {
            vi.setSystemTime(local(10, 9, 21));
            const { result } = renderHook(() => useMaintenanceForm());
            act(() => result.current.openForAdd());
            act(() => result.current.setField('dueDate', '2026-10-20'));
            vi.setSystemTime(local(10, 10, 7));
            act(() => result.current.openForAdd());
            expect(result.current.form.dueDate).toBe('2026-10-20');
        });

        it("opens Add clean after an edit, not on the edited task's name and day", () => {
            vi.setSystemTime(local(10, 10, 7));
            const { result } = renderHook(() => useMaintenanceForm());
            act(() =>
                result.current.populate({ title: 'Raw-water impeller', trigger: 'annual', dueDate: '2027-03-01' }),
            );
            act(() => result.current.openForAdd());
            expect(result.current.form).toMatchObject({ title: '', trigger: 'monthly', dueDate: '2026-10-10' });
        });
    });

    describe('Galley meal-plan days', () => {
        it('a 07:00 Saturday departure from Brisbane plans Saturday to Monday, not Friday to Sunday', () => {
            // Sat 17 Oct 07:00 AEST, arriving Mon 19 Oct 18:00 AEST.
            const days = calculateMealDays('2026-10-16T21:00:00+00:00', '2026-10-19T08:00:00+00:00');
            expect(days.passageDays).toBe(3);
            expect(days.dates).toEqual(
                zone === 'Australia/Brisbane'
                    ? ['2026-10-17', '2026-10-18', '2026-10-19']
                    : // The same moments are Friday 14:00 to Monday 01:00 in Los Angeles.
                      ['2026-10-16', '2026-10-17', '2026-10-18'],
            );
        });

        it('an 18:00 Saturday departure from Los Angeles plans from Saturday', () => {
            // Sat 17 Oct 18:00 PDT (Sunday 01:00 UTC), arriving Mon 19 Oct 19:00 PDT.
            const days = calculateMealDays('2026-10-18T01:00:00.000Z', '2026-10-20T02:00:00.000Z');
            expect(days.dates[0]).toBe(zone === 'America/Los_Angeles' ? '2026-10-17' : '2026-10-18');
            expect(days.dates).toHaveLength(3);
        });

        it('a bare departure day is that day, and buffer days run on through the clock change', () => {
            const days = calculateMealDays('2026-10-28', '2026-11-07');
            expect(days.dates[0]).toBe('2026-10-28');
            expect(days).toMatchObject({ passageDays: 10, emergencyDays: 4, totalDays: 14 });
            // Fourteen consecutive local days, none twice on the 25-hour 1 November.
            expect(days.dates).toEqual(
                Array.from({ length: 14 }, (_, i) => toLocalDateString(new Date(2026, 9, 28 + i))),
            );
            expect([...days.emergencyDates]).toEqual(['2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10']);
        });

        it('an unreadable departure plans no days rather than throwing', () => {
            expect(calculateMealDays('not a date', '2026-11-07T00:00:00Z').dates).toEqual([]);
        });
    });
});

describe('every stored-day reader goes through the one helper', () => {
    it('no screen or PDF in this package reads a stored day with new Date() or a UTC split', () => {
        const code = (file: string) =>
            readFileSync(file, 'utf8')
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/^\s*\/\/.*$/gm, '');
        const files = {
            'components/vessel/inventory/SwipeableInventoryCard.tsx': /new Date\(item\.expiry_date/,
            'components/vessel/documents/SwipeableDocCard.tsx': /new Date\(doc\.expiry_date|new Date\(expiryDate/,
            'components/vessel/equipment/SwipeableEquipmentCard.tsx': /new Date\(item\.warranty_expiry/,
            'components/vessel/equipment/EquipmentDetail.tsx': /new Date\(item\.(warranty_expiry|installation_date)/,
            'components/vessel/EquipmentList.tsx': /item\.(installation_date|warranty_expiry) \|\| ''/,
            'components/vessel/InventoryList.tsx': /item\.expiry_date \|\| ''/,
            'components/vessel/DocumentsHub.tsx': /_date\.split\('T'\)/,
            'components/vessel/MaintenanceHub.tsx': /next_due_date\.split\('T'\)/,
            'hooks/useMaintenanceForm.ts': /toISOString\(\)/,
            'services/MaintenanceService.ts': /toISOString\(\)\.split/,
            'services/vessel/LocalMaintenanceService.ts': /toISOString\(\)\.split/,
            'services/pdf/pdfDates.ts': /new Date\(`\$\{value\}T00:00:00`\)/,
            'utils/displayDate.ts': /new Date\(`\$\{value\}T00:00:00`\)/,
        };
        for (const [file, stale] of Object.entries(files)) expect(code(file), file).not.toMatch(stale);
        const galley = code('services/MealPlanService.ts');
        const mealDays = galley.slice(galley.indexOf('export function calculateMealDays'));
        expect(mealDays.slice(0, mealDays.indexOf('\n}'))).not.toMatch(/toISOString/);
    });
});
