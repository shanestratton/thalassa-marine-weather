/**
 * What R&M's task form saves as a schedule, for Add and Edit alike (132-B15;
 * binder audit MAINT-17). Kept apart from the sheet so the rule is tested on
 * its own, and so Add and Edit cannot drift: they each had a copy, and Edit
 * saved a blank day as no schedule at all.
 */
import type { MaintenanceTask } from '../../../types';
import type { MaintenanceFormState } from '../../../hooks/useMaintenanceForm';
import { addLocalDays, toLocalDateString } from '../../../utils/localDate';
import { PERIOD_DAYS } from './SwipeableTaskCard';

/** An hour task's interval when its field is blank: the field's placeholder, and what a logged service counts with. */
export const DEFAULT_HOURS_INTERVAL = 200;

/** A whole number as typed ('1,250', ' 200 '), or null for a blank or anything else. */
export function wholeNumber(text: string): number | null {
    const cleaned = text.replace(/[,\s]/g, '');
    if (!/^\d+$/.test(cleaned)) return null;
    const value = Number(cleaned);
    return Number.isSafeInteger(value) ? value : null;
}

export type TaskSchedule = Pick<
    MaintenanceTask,
    'trigger_type' | 'interval_value' | 'next_due_date' | 'next_due_hours'
>;

/**
 * The schedule a task form saves. Blank fields save sensibly:
 *  - an hour task's blank (or unreadable) interval is 200 hours;
 *  - its blank 'Next due' is the engine's reading plus the interval, as a
 *    logged service sets it, or unset with no reading yet, never counted from
 *    zero (126-B1). It used to save unset with a reading on show, and the new
 *    task sat grey, "Log a service to schedule";
 *  - a calendar task's blank day is a whole period from today, on the
 *    skipper's own calendar (131-B11);
 *  - a pre-trip check has no day: it waits for a trip.
 */
export function scheduleFromForm(
    form: Pick<MaintenanceFormState, 'trigger' | 'interval' | 'dueDate' | 'dueHours'>,
    engineHours: number | null,
    now: Date = new Date(),
): TaskSchedule {
    if (form.trigger === 'engine_hours') {
        const interval = wholeNumber(form.interval) || DEFAULT_HOURS_INTERVAL;
        return {
            trigger_type: 'engine_hours',
            interval_value: interval,
            next_due_date: null,
            next_due_hours: wholeNumber(form.dueHours) ?? (engineHours === null ? null : engineHours + interval),
        };
    }
    const periodDays = PERIOD_DAYS[form.trigger] ?? 30;
    return {
        trigger_type: form.trigger,
        interval_value: periodDays,
        next_due_date:
            form.trigger === 'daily' ? null : form.dueDate || toLocalDateString(addLocalDays(now, periodDays)),
        next_due_hours: null,
    };
}
