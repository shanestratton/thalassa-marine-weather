/**
 * The Plan page's departure, as one seam (build 124, Plan Your Day slice 2).
 *
 * DepartControl used to own the read and the write privately, so a second
 * writer (Plan Your Day's "Plot on chart") would have left the Plan page's
 * Departure card showing the old time. services/planDeparture.ts now holds
 * both, with the same key, the same account-scoped sessionStorage and the
 * same identity-tagged event, and DepartControl listens for that event.
 */
import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';

vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

import {
    PLAN_DEPARTURE_EVENT,
    PLAN_DEPARTURE_KEY,
    planDepartureFromEvent,
    readPlanDeparture,
    setPlanDeparture,
} from '../services/planDeparture';
import { DepartControl } from '../components/passage/DepartControl';

const H = 3_600_000;

function localDate(ms: number): string {
    const date = new Date(ms);
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function listen(): { events: CustomEvent[]; stop: () => void } {
    const events: CustomEvent[] = [];
    const on = (event: Event) => events.push(event as CustomEvent);
    window.addEventListener(PLAN_DEPARTURE_EVENT, on);
    return { events, stop: () => window.removeEventListener(PLAN_DEPARTURE_EVENT, on) };
}

describe('planDeparture: the Plan page departure, read and written in one place', () => {
    beforeEach(() => {
        sessionStorage.clear();
        setAuthIdentityScope(null);
        setAuthIdentityScope('account-a');
    });

    it('keeps the key and the event the tracer already reads', () => {
        expect(PLAN_DEPARTURE_KEY).toBe('thalassa_trace_departure_ms');
        expect(PLAN_DEPARTURE_EVENT).toBe('thalassa:departure-changed');
    });

    it("writes only the current account's copy, and reads it back", () => {
        const a = getAuthIdentityScope();
        const ms = Date.now() + 3 * H;
        expect(setPlanDeparture(ms)).toBe(true);
        expect(sessionStorage.getItem(authScopedStorageKey(PLAN_DEPARTURE_KEY, a))).toBe(String(ms));
        expect(sessionStorage.getItem(PLAN_DEPARTURE_KEY)).toBeNull();
        expect(readPlanDeparture()).toBe(ms);

        const b = setAuthIdentityScope('account-b');
        expect(readPlanDeparture()).toBeNull();
        expect(readPlanDeparture(b)).toBeNull();
    });

    it('announces the change, tagged with the account it belongs to', () => {
        const scope = getAuthIdentityScope();
        const heard = listen();
        try {
            const ms = Date.now() + 2 * H;
            setPlanDeparture(ms);
            setPlanDeparture(null);
            expect(heard.events.map((e) => e.detail)).toEqual([
                { ms, scopeKey: scope.key, scopeGeneration: scope.generation },
                { ms: null, scopeKey: scope.key, scopeGeneration: scope.generation },
            ]);
        } finally {
            heard.stop();
        }
    });

    it('null clears the departure ("leaving now")', () => {
        setPlanDeparture(Date.now() + H);
        expect(setPlanDeparture(null)).toBe(true);
        expect(readPlanDeparture()).toBeNull();
        expect(sessionStorage.getItem(authScopedStorageKey(PLAN_DEPARTURE_KEY, getAuthIdentityScope()))).toBeNull();
    });

    it('refuses a write that began under another account, and says nothing', () => {
        const a = getAuthIdentityScope();
        const b = setAuthIdentityScope('account-b');
        const heard = listen();
        try {
            expect(setPlanDeparture(Date.now() + H, a)).toBe(false);
            expect(sessionStorage.getItem(authScopedStorageKey(PLAN_DEPARTURE_KEY, a))).toBeNull();
            expect(sessionStorage.getItem(authScopedStorageKey(PLAN_DEPARTURE_KEY, b))).toBeNull();
            expect(heard.events).toHaveLength(0);
        } finally {
            heard.stop();
        }
    });

    it('refuses a time that is not a number', () => {
        expect(setPlanDeparture(Number.NaN)).toBe(false);
        expect(setPlanDeparture(Number.POSITIVE_INFINITY)).toBe(false);
        expect(readPlanDeparture()).toBeNull();
    });

    it('forgets a departure more than an hour gone, as the card always has', () => {
        const key = authScopedStorageKey(PLAN_DEPARTURE_KEY, getAuthIdentityScope());
        sessionStorage.setItem(key, String(Date.now() - 2 * H));
        expect(readPlanDeparture()).toBeNull();
        sessionStorage.setItem(key, String(Date.now() - 0.5 * H));
        expect(readPlanDeparture()).not.toBeNull();
        sessionStorage.setItem(key, 'soon');
        expect(readPlanDeparture()).toBeNull();
    });

    it('reads the old unscoped key only in the anonymous scope', () => {
        const ms = Date.now() + H;
        sessionStorage.setItem(PLAN_DEPARTURE_KEY, String(ms));
        expect(readPlanDeparture()).toBeNull();
        setAuthIdentityScope(null);
        expect(readPlanDeparture()).toBe(ms);
    });

    it("reads an event only when it is this account's", () => {
        const scope = getAuthIdentityScope();
        const mine = new CustomEvent(PLAN_DEPARTURE_EVENT, {
            detail: { ms: 123, scopeKey: scope.key, scopeGeneration: scope.generation },
        });
        expect(planDepartureFromEvent(mine)).toEqual({ ms: 123 });
        const cleared = new CustomEvent(PLAN_DEPARTURE_EVENT, {
            detail: { ms: null, scopeKey: scope.key, scopeGeneration: scope.generation },
        });
        expect(planDepartureFromEvent(cleared)).toEqual({ ms: null });
        const theirs = new CustomEvent(PLAN_DEPARTURE_EVENT, {
            detail: { ms: 123, scopeKey: 'user:account-b', scopeGeneration: scope.generation },
        });
        expect(planDepartureFromEvent(theirs)).toBeNull();
        const old = new CustomEvent(PLAN_DEPARTURE_EVENT, {
            detail: { ms: 123, scopeKey: scope.key, scopeGeneration: scope.generation - 1 },
        });
        expect(planDepartureFromEvent(old)).toBeNull();
        expect(planDepartureFromEvent(new Event(PLAN_DEPARTURE_EVENT))).toBeNull();
    });
});

describe('DepartControl follows a departure set somewhere else', () => {
    beforeEach(() => {
        sessionStorage.clear();
        setAuthIdentityScope(null);
        setAuthIdentityScope('account-a');
    });

    it("updates the Plan page's Departure card when Plan Your Day sets the time", () => {
        render(<DepartControl />);
        expect(screen.getByText('leaving now')).toBeInTheDocument();

        const day = localDate(Date.now() + 3 * 24 * H);
        const ms = new Date(`${day}T14:35`).getTime();
        act(() => {
            setPlanDeparture(ms);
        });
        expect(screen.getByLabelText('Departure date')).toHaveValue(day);
        expect(screen.getByLabelText('Departure hour (24-hour)')).toHaveValue('14');
        expect(screen.getByLabelText('Departure minutes')).toHaveValue('35');
        expect(screen.queryByText('leaving now')).not.toBeInTheDocument();

        act(() => {
            setPlanDeparture(null);
        });
        expect(screen.getByText('leaving now')).toBeInTheDocument();
    });

    it("ignores a departure event tagged with another account's scope", () => {
        render(<DepartControl />);
        const scope = getAuthIdentityScope();
        act(() => {
            window.dispatchEvent(
                new CustomEvent(PLAN_DEPARTURE_EVENT, {
                    detail: {
                        ms: Date.now() + 5 * 24 * H,
                        scopeKey: 'user:account-b',
                        scopeGeneration: scope.generation,
                    },
                }),
            );
        });
        expect(screen.getByText('leaving now')).toBeInTheDocument();
    });
});
