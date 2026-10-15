/**
 * R&M due-soon window and "Done today" (Shane, 2026-10-02: "the check engine
 * and coolant which is due tomorrow, is not renewing its dates ... it is all of
 * the due soon items that are not updating").
 *
 * Every log saved and renewed: a DAILY task logged today is due tomorrow,
 * which the card already said, and a flat 14-day amber window meant a daily
 * task could never turn green. So the amber window scales with the interval,
 * and a task logged today says so. Clocks are pinned; local Date constructors
 * keep it right under TZ=UTC (CI) and on a Brisbane Mac alike.
 * No real accounts: 'skipper-1'.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { calculateStatus, dueSoonWindowDays, isLocalToday } from '../services/MaintenanceService';
import { SwipeableTaskCard, readableStatusLabel } from '../components/vessel/maintenance/SwipeableTaskCard';
import { ServiceLogSheet } from '../components/vessel/maintenance/ServiceLogSheet';
import type { MaintenanceTask } from '../types';

/** Fri 2 Oct 2026, 7:34 pm local. */
const NOW = new Date(2026, 9, 2, 19, 34, 0);

/** Local 'YYYY-MM-DD', `offset` days from NOW. */
function day(offset: number): string {
    const d = new Date(NOW);
    d.setDate(d.getDate() + offset);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A local instant `offset` days from NOW at hh:mm, as an ISO string. */
function at(offset: number, hours: number, minutes: number): string {
    const d = new Date(NOW);
    d.setDate(d.getDate() + offset);
    d.setHours(hours, minutes, 0, 0);
    return d.toISOString();
}

const task = (overrides: Partial<MaintenanceTask> = {}): MaintenanceTask => ({
    id: 'task-1',
    user_id: 'skipper-1',
    title: 'Check Engine Oil & Coolant Levels',
    description: null,
    category: 'Engine',
    trigger_type: 'daily',
    interval_value: 1,
    next_due_date: null,
    next_due_hours: null,
    last_completed: null,
    is_active: true,
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    ...overrides,
});

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
});

afterEach(() => {
    vi.useRealTimers();
});

describe('the due-soon window scales with the interval', () => {
    it('is the due day alone for a daily task, a quarter of the interval otherwise, 1 to 14 days', () => {
        expect(dueSoonWindowDays(task({ trigger_type: 'daily', interval_value: 1 }))).toBe(0);
        expect(dueSoonWindowDays(task({ trigger_type: 'daily', interval_value: 2 }))).toBe(1);
        expect(dueSoonWindowDays(task({ trigger_type: 'daily', interval_value: 7 }))).toBe(2);
        expect(dueSoonWindowDays(task({ trigger_type: 'monthly', interval_value: 30 }))).toBe(8);
        expect(dueSoonWindowDays(task({ trigger_type: 'quarterly', interval_value: 90 }))).toBe(14);
        expect(dueSoonWindowDays(task({ trigger_type: 'bi_annual', interval_value: 182 }))).toBe(14);
        expect(dueSoonWindowDays(task({ trigger_type: 'annual', interval_value: 365 }))).toBe(14);
    });

    it('keeps 14 days for a task with no interval in days', () => {
        expect(dueSoonWindowDays(task({ trigger_type: 'monthly', interval_value: null }))).toBe(14);
        expect(dueSoonWindowDays(task({ trigger_type: 'monthly', interval_value: 0 }))).toBe(14);
        // An engine-hours interval is hours, not days.
        expect(dueSoonWindowDays(task({ trigger_type: 'engine_hours', interval_value: 100 }))).toBe(14);
    });

    // 132-B15 (MAINT-06): a daily task is a pre-trip check. It went amber on
    // its day and red the next in port; now it waits for a trip.
    it('a pre-trip check is never amber or red by its date: it waits for the next trip', () => {
        for (const offset of [1, 0, -1, -30]) {
            const status = calculateStatus(task({ next_due_date: day(offset) }), 0);
            expect(status.status, `due ${offset}`).toBe('green');
            expect(status.statusLabel).toBe('Due before your next trip');
            expect(status.beforeTrip).toBe(true);
            expect(status.daysRemaining).toBeNull();
        }
        // Never logged, no day at all: still waiting for a trip, not "No schedule set".
        expect(calculateStatus(task({ next_due_date: null }), 0).statusLabel).toBe('Due before your next trip');
    });

    it('a monthly task goes amber about a week out', () => {
        const monthly = { trigger_type: 'monthly' as const, interval_value: 30 };
        expect(calculateStatus(task({ ...monthly, next_due_date: day(8) }), 0).status).toBe('yellow');
        const nine = calculateStatus(task({ ...monthly, next_due_date: day(9) }), 0);
        expect(nine.status).toBe('green');
        expect(nine.statusLabel).toBe('Due in 9 days');
    });

    it('quarterly and longer, and tasks with no interval, keep the fortnight', () => {
        const quarterly = { trigger_type: 'quarterly' as const, interval_value: 90 };
        expect(calculateStatus(task({ ...quarterly, next_due_date: day(14) }), 0).status).toBe('yellow');
        expect(calculateStatus(task({ ...quarterly, next_due_date: day(15) }), 0).status).toBe('green');
        const open = { trigger_type: 'monthly' as const, interval_value: null };
        expect(calculateStatus(task({ ...open, next_due_date: day(14) }), 0).status).toBe('yellow');
        expect(calculateStatus(task({ ...open, next_due_date: day(15) }), 0).status).toBe('green');
    });

    it('leaves the engine-hours window and overdue logic as they were', () => {
        const hours = { trigger_type: 'engine_hours' as const, interval_value: 100 };
        expect(calculateStatus(task({ ...hours, next_due_hours: 1270 }), 1250).status).toBe('yellow');
        expect(calculateStatus(task({ ...hours, next_due_hours: 1271 }), 1250).status).toBe('green');
        const over = calculateStatus(task({ ...hours, next_due_hours: 1240 }), 1250);
        expect(over.status).toBe('red');
        expect(over.statusLabel).toBe('Overdue by 10 hrs');
    });
});

/** A calendar task: the rules below are a schedule's, which a pre-trip check no longer has. */
const calendar = { trigger_type: 'monthly' as const, interval_value: 30 };

describe('Done today', () => {
    it('the stuck daily check: logged today, renewed to tomorrow, reads green "Done today · due again next trip"', () => {
        // Exactly what LocalMaintenanceService.logService writes: now + 1 day.
        const logged = task({ last_completed: at(0, 19, 34), next_due_date: at(1, 19, 34) });
        const status = calculateStatus(logged, 0);
        expect(status.status).toBe('green');
        expect(status.statusLabel).toBe('Done today · due again next trip');
        expect(status.doneToday).toBe(true);
        expect(status.daysRemaining).toBeNull();
        // Tomorrow it waits for a trip again, rather than going amber or red.
        vi.setSystemTime(new Date(2026, 9, 4, 9, 0));
        expect(calculateStatus(logged, 0).statusLabel).toBe('Due before your next trip');
    });

    it('a calendar task logged today, due tomorrow, reads "Done today · next tomorrow"', () => {
        const status = calculateStatus(task({ ...calendar, last_completed: at(0, 19, 34), next_due_date: day(1) }), 0);
        expect(status.statusLabel).toBe('Done today · next tomorrow');
        expect(status.daysRemaining).toBe(1);
    });

    it('says how far off the next one is, in days or engine hours', () => {
        const monthly = calculateStatus(
            task({ trigger_type: 'monthly', interval_value: 30, last_completed: at(0, 8, 5), next_due_date: day(30) }),
            0,
        );
        expect(monthly.status).toBe('green');
        expect(monthly.statusLabel).toBe('Done today · next in 30 days');

        // 10 hours to go would be amber; logged today it is done.
        const hours = calculateStatus(
            task({
                trigger_type: 'engine_hours',
                interval_value: 10,
                last_completed: at(0, 9, 0),
                next_due_hours: 1260,
            }),
            1250,
        );
        expect(hours.status).toBe('green');
        expect(hours.statusLabel).toBe('Done today · next at 1260 hrs');
    });

    it('goes by the local calendar day the log fell on', () => {
        const justAfterMidnight = calculateStatus(
            task({ ...calendar, last_completed: at(0, 0, 10), next_due_date: day(1) }),
            0,
        );
        expect(justAfterMidnight.doneToday).toBe(true);
        expect(isLocalToday(at(0, 0, 10))).toBe(true);
        // A pre-trip check too.
        expect(calculateStatus(task({ last_completed: at(0, 0, 10) }), 0).doneToday).toBe(true);
        expect(calculateStatus(task({ last_completed: at(-1, 23, 50) }), 0).doneToday).toBe(false);

        const lateYesterday = calculateStatus(
            task({ ...calendar, last_completed: at(-1, 23, 50), next_due_date: day(0) }),
            0,
        );
        expect(lateYesterday.doneToday).toBe(false);
        expect(lateYesterday.status).toBe('yellow');
        expect(lateYesterday.statusLabel).toBe('Due today');
        expect(isLocalToday(at(-1, 23, 50))).toBe(false);
        expect(isLocalToday(null)).toBe(false);
    });

    it('never hides an overdue task, a paused one, or one with no schedule', () => {
        const overdue = calculateStatus(task({ ...calendar, last_completed: at(0, 7, 0), next_due_date: day(-2) }), 0);
        expect(overdue.status).toBe('red');
        expect(overdue.doneToday).toBe(false);

        const paused = calculateStatus(
            task({ last_completed: at(0, 7, 0), next_due_date: day(1), is_active: false }),
            0,
        );
        expect(paused.status).toBe('grey');
        expect(paused.statusLabel).toBe('Paused');
        expect(paused.doneToday).toBe(false);

        const unscheduled = calculateStatus(task({ ...calendar, last_completed: at(0, 7, 0) }), 0);
        expect(unscheduled.status).toBe('grey');
        expect(unscheduled.statusLabel).toBe('No schedule set');
    });

    it('reads a long wait in months, as the other labels do', () => {
        expect(readableStatusLabel('Done today · next in 365 days')).toBe('Done today · next in 12 months');
        expect(readableStatusLabel('Done today · next in 30 days')).toBe('Done today · next in 30 days');
        expect(readableStatusLabel('Done today · next tomorrow')).toBe('Done today · next tomorrow');
    });
});

describe('the R&M card and the Log service sheet', () => {
    it('a task done today keeps its row to one line at 320 pt: a shorter date, none under 360 pt', () => {
        const done = calculateStatus(task({ ...calendar, last_completed: at(0, 19, 34), next_due_date: day(1) }), 0);
        const { unmount } = render(<SwipeableTaskCard task={done} onTap={vi.fn()} />);
        expect(screen.getByText('Done today · next tomorrow')).toBeInTheDocument();
        expect(screen.getByText('3 Oct 2026')).toBeInTheDocument();
        expect(screen.queryByText('Sat 3 Oct 2026')).not.toBeInTheDocument();
        expect(screen.getByTestId('task-due-detail')).toHaveClass('max-[360px]:hidden');
        unmount();

        const notDone = calculateStatus(task({ ...calendar, next_due_date: day(1) }), 0);
        render(<SwipeableTaskCard task={notDone} onTap={vi.fn()} />);
        expect(screen.getByText('Sat 3 Oct 2026')).toBeInTheDocument();
        expect(screen.getByTestId('task-due-detail')).not.toHaveClass('max-[360px]:hidden');
    });

    it('a pre-trip check shows no due day beside its label: the day a log rolled it on to is not one', () => {
        const done = calculateStatus(task({ last_completed: at(0, 19, 34), next_due_date: day(1) }), 0);
        const { unmount } = render(<SwipeableTaskCard task={done} onTap={vi.fn()} />);
        expect(screen.getByText('Done today · due again next trip')).toBeInTheDocument();
        expect(screen.getByTestId('task-due-detail')).toBeEmptyDOMElement();
        unmount();

        const waiting = calculateStatus(task({ next_due_date: day(-5) }), 0);
        render(<SwipeableTaskCard task={waiting} onTap={vi.fn()} />);
        expect(screen.getByText('Due before your next trip')).toBeInTheDocument();
        expect(screen.queryByText(/Overdue/)).not.toBeInTheDocument();
        expect(screen.getByTestId('task-due-detail')).toBeEmptyDOMElement();
    });

    function renderSheet(lastCompleted: string | null) {
        const status = calculateStatus(task({ last_completed: lastCompleted, next_due_date: day(1) }), 0);
        return render(
            <ServiceLogSheet
                task={status}
                engineHours={null}
                notes=""
                onNotesChange={vi.fn()}
                saving={false}
                onLog={vi.fn()}
                onHistory={vi.fn()}
                onEdit={vi.fn()}
                onClose={vi.fn()}
            />,
        );
    }

    it('says when the task was already logged today, and still lets it be logged again', () => {
        // In the phone's own clock (126-B7a): 'en-AU' was hard-coded, so a
        // sailor in Lisbon or Seattle read '7:34 pm' however their phone is set.
        const clock = vi.spyOn(Date.prototype, 'toLocaleTimeString');
        renderSheet(at(0, 19, 34));
        const phone = new Date(at(0, 19, 34))
            .toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
            .replace(/\s+/g, ' ');
        expect(screen.getByText(`Already logged today at ${phone}`)).toBeInTheDocument();
        expect(clock).toHaveBeenCalledWith(undefined, { hour: 'numeric', minute: '2-digit' });
        expect(clock).not.toHaveBeenCalledWith('en-AU', expect.anything());
        expect(screen.getByRole('button', { name: 'Log service' })).toBeEnabled();
        clock.mockRestore();
    });

    it('says nothing of the kind for a task last logged yesterday', () => {
        renderSheet(at(-1, 19, 34));
        expect(screen.queryByText(/Already logged today/)).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Log service' })).toBeEnabled();
    });
});
