/**
 * The Galley's Active meals in the order they are eaten (132-B17, binder
 * audit GAL-11).
 *
 * The tab listed every planned meal in the order it was saved, each under a
 * raw '2026-10-09 · dinner'. Now: Today first (with a meal on the stove,
 * whatever day it was planned for), then Next (the next day with a meal
 * planned), then Later, each by day and then breakfast, lunch, dinner. A meal
 * planned for a day that has passed and never cooked or skipped still holds
 * its ingredients, so it is listed last, under Earlier, never dropped.
 * Days are the phone's local days, as the meal calendar plans them (131-B11).
 */
import type { MealPlan, MealSlot } from '../MealPlanService';
import { localDaysUntil, readLocalDay } from '../../utils/localDate';

export type ActiveMealGroup = 'today' | 'next' | 'later' | 'earlier';

export interface ActiveMealSection {
    group: ActiveMealGroup;
    /** The heading over the group: 'Today', 'Next', 'Later', 'Earlier'. */
    title: string;
    meals: MealPlan[];
}

const GROUP_TITLES: Record<ActiveMealGroup, string> = {
    today: 'Today',
    next: 'Next',
    later: 'Later',
    earlier: 'Earlier',
};

const GROUP_ORDER: ActiveMealGroup[] = ['today', 'next', 'later', 'earlier'];

/** Through the day: an unknown slot after them all. */
const SLOT_ORDER: Record<MealSlot, number> = { breakfast: 0, lunch: 1, dinner: 2, snack: 3 };

const SLOT_NAMES: Record<MealSlot, string> = {
    breakfast: 'Breakfast',
    lunch: 'Lunch',
    dinner: 'Dinner',
    snack: 'Snack',
};

/** 'Dinner' for 'dinner'; a slot this build does not know, as stored. */
export function mealSlotName(slot: string): string {
    return SLOT_NAMES[slot as MealSlot] ?? slot;
}

/**
 * The meal's day in words: 'Today', 'Tomorrow', 'Yesterday', or 'Sat 18 Oct'
 * (with the year once it is not this one). 'No date' for one that will not read.
 */
export function mealDayLabel(plannedDate: string, now: Date = new Date()): string {
    const days = localDaysUntil(plannedDate, now);
    const day = readLocalDay(plannedDate);
    if (days === null || !day) return 'No date';
    if (days === 0) return 'Today';
    if (days === 1) return 'Tomorrow';
    if (days === -1) return 'Yesterday';
    return day.toLocaleDateString(undefined, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        ...(day.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
    });
}

/** 'Tomorrow · Dinner · 4 serves': the line under a meal's title. */
export function mealWhenLine(
    meal: Pick<MealPlan, 'planned_date' | 'meal_slot' | 'servings_planned'>,
    now?: Date,
): string {
    const serves = `${meal.servings_planned} ${meal.servings_planned === 1 ? 'serve' : 'serves'}`;
    return `${mealDayLabel(meal.planned_date, now)} · ${mealSlotName(meal.meal_slot)} · ${serves}`;
}

/** The active meals (reserved or cooking) in sections, in the order they are eaten. */
export function activeMealSections(meals: readonly MealPlan[], now: Date = new Date()): ActiveMealSection[] {
    const dated = meals.map((meal) => ({ meal, days: localDaysUntil(meal.planned_date, now) }));
    const nextDay = dated.reduce<number | null>(
        (soonest, { days }) => (days !== null && days > 0 && (soonest === null || days < soonest) ? days : soonest),
        null,
    );
    const groupOf = ({ meal, days }: (typeof dated)[number]): ActiveMealGroup => {
        // On the stove now, whatever day it was planned for.
        if (meal.status === 'cooking' || days === 0) return 'today';
        // A date that will not read is never dropped: it waits at the end of Later.
        if (days === null) return 'later';
        if (days < 0) return 'earlier';
        return days === nextDay ? 'next' : 'later';
    };

    const byTime = (a: (typeof dated)[number], b: (typeof dated)[number], group: ActiveMealGroup) => {
        if (group === 'today' && (a.meal.status === 'cooking') !== (b.meal.status === 'cooking')) {
            return a.meal.status === 'cooking' ? -1 : 1;
        }
        const aDays = a.days ?? Number.POSITIVE_INFINITY;
        const bDays = b.days ?? Number.POSITIVE_INFINITY;
        // Earlier: the most recent day first, the one most likely still in the fridge.
        if (aDays !== bDays) return group === 'earlier' ? bDays - aDays : aDays - bDays;
        const slot = (SLOT_ORDER[a.meal.meal_slot] ?? 9) - (SLOT_ORDER[b.meal.meal_slot] ?? 9);
        if (slot !== 0) return slot;
        return a.meal.title.localeCompare(b.meal.title);
    };

    return GROUP_ORDER.map((group) => ({
        group,
        title: GROUP_TITLES[group],
        meals: dated
            .filter((entry) => groupOf(entry) === group)
            .sort((a, b) => byTime(a, b, group))
            .map((entry) => entry.meal),
    })).filter((section) => section.meals.length > 0);
}
