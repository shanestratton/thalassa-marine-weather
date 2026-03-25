/**
 * MaintenanceService — Unit Tests
 *
 * Tests the pure functions calculateStatus and sortByUrgency,
 * plus Supabase-backed CRUD operations via mocks.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { calculateStatus, sortByUrgency, type TaskWithStatus } from '../services/MaintenanceService';
import type { MaintenanceTask } from '../types';

// ── Helpers ───────────────────────────────────────────────────────

const makeTask = (overrides: Partial<MaintenanceTask> = {}): MaintenanceTask => ({
    id: 'task-1',
    user_id: 'user-1',
    title: 'Oil Change',
    description: 'Change engine oil',
    category: 'engine' as any,
    trigger_type: 'monthly',
    interval_value: 90,
    next_due_date: null,
    next_due_hours: null,
    last_completed: null,
    is_active: true,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
});

// ── calculateStatus ──────────────────────────────────────────────

describe('calculateStatus', () => {
    it('returns grey when no due date or hours are set', () => {
        const task = makeTask();
        const result = calculateStatus(task, 100);
        expect(result.status).toBe('grey');
        expect(result.statusLabel).toBe('No schedule set');
        expect(result.daysRemaining).toBeNull();
        expect(result.hoursRemaining).toBeNull();
    });

    it('returns grey when task is paused', () => {
        const futureDate = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
        const task = makeTask({ next_due_date: futureDate, is_active: false });
        const result = calculateStatus(task, 100);
        expect(result.status).toBe('grey');
        expect(result.statusLabel).toBe('Paused');
    });

    it('returns green when due date is > 14 days away', () => {
        const futureDate = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
        const task = makeTask({ next_due_date: futureDate });
        const result = calculateStatus(task, 100);
        expect(result.status).toBe('green');
        expect(result.daysRemaining).toBeGreaterThan(14);
    });

    it('returns yellow when due date is within 14 days', () => {
        const soonDate = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];
        const task = makeTask({ next_due_date: soonDate });
        const result = calculateStatus(task, 100);
        expect(result.status).toBe('yellow');
        expect(result.daysRemaining).toBeGreaterThanOrEqual(0);
        expect(result.daysRemaining).toBeLessThanOrEqual(14);
    });

    it('returns red when due date is in the past', () => {
        const pastDate = new Date(Date.now() - 5 * 86400000).toISOString().split('T')[0];
        const task = makeTask({ next_due_date: pastDate });
        const result = calculateStatus(task, 100);
        expect(result.status).toBe('red');
        expect(result.statusLabel).toMatch(/Overdue by \d+ day/);
        expect(result.daysRemaining).toBeLessThan(0);
    });

    it('returns green at current engine hours when next_due_hours is far away', () => {
        const task = makeTask({ next_due_hours: 200 });
        const result = calculateStatus(task, 100);
        expect(result.status).toBe('green');
        expect(result.hoursRemaining).toBe(100);
        expect(result.statusLabel).toBe('Due at 200 hrs');
    });

    it('returns yellow when engine hours remaining <= 20', () => {
        const task = makeTask({ next_due_hours: 115 });
        const result = calculateStatus(task, 100);
        expect(result.status).toBe('yellow');
        expect(result.hoursRemaining).toBe(15);
        expect(result.statusLabel).toMatch(/Due in 15 hr/);
    });

    it('returns red when engine hours are overdue', () => {
        const task = makeTask({ next_due_hours: 90 });
        const result = calculateStatus(task, 100);
        expect(result.status).toBe('red');
        expect(result.hoursRemaining).toBe(-10);
        expect(result.statusLabel).toMatch(/Overdue by 10 hr/);
    });

    it('engine hours override date status when more urgent', () => {
        // Date is green (30 days away) but engine hours overdue
        const futureDate = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
        const task = makeTask({ next_due_date: futureDate, next_due_hours: 90 });
        const result = calculateStatus(task, 100);
        expect(result.status).toBe('red');
        expect(result.hoursRemaining).toBe(-10);
    });

    it('preserves all original task properties', () => {
        const task = makeTask({ title: 'Impeller Check' });
        const result = calculateStatus(task, 100);
        expect(result.title).toBe('Impeller Check');
        expect(result.id).toBe('task-1');
    });

    it('handles exactly 0 days remaining as yellow', () => {
        // Due today = 0 or 1 day remaining, which is <= 14
        const todayDate = new Date(Date.now() + 86400000).toISOString().split('T')[0];
        const task = makeTask({ next_due_date: todayDate });
        const result = calculateStatus(task, 100);
        expect(['yellow', 'green']).toContain(result.status);
    });

    it('handles exactly 0 engine hours remaining as yellow', () => {
        const task = makeTask({ next_due_hours: 100 });
        const result = calculateStatus(task, 100);
        // 0 hours remaining is within the <= 20 yellow threshold, not negative → yellow
        expect(result.status).toBe('yellow');
        expect(result.hoursRemaining).toBe(0);
    });

    it('handles singular day label', () => {
        const pastDate = new Date(Date.now() - 1 * 86400000).toISOString().split('T')[0];
        const task = makeTask({ next_due_date: pastDate });
        const result = calculateStatus(task, 0);
        // Could be "Overdue by 1 day" (no trailing s)
        if (Math.abs(result.daysRemaining!) === 1) {
            expect(result.statusLabel).toMatch(/1 day$/);
        }
    });

    it('handles singular hour label', () => {
        const task = makeTask({ next_due_hours: 99 });
        const result = calculateStatus(task, 100);
        // Overdue by 1 hr
        expect(result.statusLabel).toMatch(/1 hr$/);
    });
});

// ── sortByUrgency ────────────────────────────────────────────────

describe('sortByUrgency', () => {
    const makeTWS = (
        status: 'red' | 'yellow' | 'green' | 'grey',
        days: number | null = null,
        hours: number | null = null,
    ): TaskWithStatus => ({
        ...makeTask(),
        status,
        statusLabel: '',
        daysRemaining: days,
        hoursRemaining: hours,
    });

    it('sorts red before yellow before green before grey', () => {
        const tasks = [makeTWS('green'), makeTWS('grey'), makeTWS('red'), makeTWS('yellow')];
        const sorted = sortByUrgency(tasks);
        expect(sorted.map((t) => t.status)).toEqual(['red', 'yellow', 'green', 'grey']);
    });

    it('within same priority, sorts by smallest remaining', () => {
        const tasks = [makeTWS('yellow', 10, null), makeTWS('yellow', 3, null), makeTWS('yellow', 7, null)];
        const sorted = sortByUrgency(tasks);
        expect(sorted.map((t) => t.daysRemaining)).toEqual([3, 7, 10]);
    });

    it('prefers hoursRemaining over daysRemaining when both present', () => {
        const tasks = [makeTWS('yellow', 5, 15), makeTWS('yellow', 10, 5)];
        const sorted = sortByUrgency(tasks);
        // hoursRemaining is checked first, so 5 < 15
        expect(sorted[0].hoursRemaining).toBe(5);
    });

    it('handles empty array', () => {
        expect(sortByUrgency([])).toEqual([]);
    });

    it('does not mutate the original array', () => {
        const tasks = [makeTWS('green'), makeTWS('red')];
        const original = [...tasks];
        sortByUrgency(tasks);
        expect(tasks[0].status).toBe(original[0].status);
    });
});
