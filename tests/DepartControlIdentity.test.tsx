import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';

vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

import { DepartControl } from '../components/passage/DepartControl';

const STORAGE_KEY = 'thalassa_trace_departure_ms';

function localDate(ms: number): string {
    const date = new Date(ms);
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

describe('DepartControl identity boundary', () => {
    beforeEach(() => {
        sessionStorage.clear();
        setAuthIdentityScope(null);
        setAuthIdentityScope('account-a');
    });

    it('shows only the active account departure and tags cross-surface events', () => {
        const accountAScope = getAuthIdentityScope();
        const accountADeparture = Date.now() + 2 * 24 * 60 * 60 * 1000;
        sessionStorage.setItem(authScopedStorageKey(STORAGE_KEY, accountAScope), String(accountADeparture));
        const accountBScope = setAuthIdentityScope('account-b');
        const accountBDeparture = Date.now() + 5 * 24 * 60 * 60 * 1000;
        sessionStorage.setItem(authScopedStorageKey(STORAGE_KEY, accountBScope), String(accountBDeparture));
        setAuthIdentityScope('account-a');

        render(<DepartControl />);
        const dateInput = screen.getByLabelText('Departure date') as HTMLInputElement;
        expect(dateInput.value).toBe(localDate(accountADeparture));

        act(() => {
            setAuthIdentityScope('account-b');
        });
        expect(dateInput.value).toBe(localDate(accountBDeparture));

        const onDeparture = vi.fn();
        window.addEventListener('thalassa:departure-changed', onDeparture);
        const nextDate = localDate(Date.now() + 7 * 24 * 60 * 60 * 1000);
        fireEvent.change(dateInput, { target: { value: nextDate } });

        const event = onDeparture.mock.calls[0]?.[0] as CustomEvent;
        expect(event.detail).toMatchObject({
            scopeKey: accountBScope.key,
            scopeGeneration: getAuthIdentityScope().generation,
        });
        expect(sessionStorage.getItem(authScopedStorageKey(STORAGE_KEY, accountAScope))).toBe(
            String(accountADeparture),
        );
        expect(sessionStorage.getItem(authScopedStorageKey(STORAGE_KEY, accountBScope))).not.toBe(
            String(accountBDeparture),
        );
        window.removeEventListener('thalassa:departure-changed', onDeparture);
    });

    it('shows an enabled Now button instead of OK even when already leaving now', () => {
        const scope = getAuthIdentityScope();
        const onDeparture = vi.fn();
        window.addEventListener('thalassa:departure-changed', onDeparture);
        try {
            render(<DepartControl />);
            expect(screen.queryByRole('button', { name: 'OK' })).not.toBeInTheDocument();
            const now = screen.getByRole('button', { name: 'Now' });
            expect(now).toBeEnabled();
            expect(now).toHaveAttribute('type', 'button');
            expect(screen.getByText('leaving now')).toBeInTheDocument();

            fireEvent.click(now);
            fireEvent.click(now);
            expect(screen.getByRole('button', { name: 'Now' })).toBeEnabled();
            expect(sessionStorage.getItem(authScopedStorageKey(STORAGE_KEY, scope))).toBeNull();
            expect(onDeparture).toHaveBeenCalledTimes(2);
            for (const [event] of onDeparture.mock.calls as [CustomEvent][]) {
                expect(event.detail).toEqual({
                    ms: null,
                    scopeKey: scope.key,
                    scopeGeneration: scope.generation,
                });
            }
        } finally {
            window.removeEventListener('thalassa:departure-changed', onDeparture);
        }
    });

    it('applies date/time edits immediately, then Now clears the scoped departure through remount', () => {
        const scope = getAuthIdentityScope();
        const key = authScopedStorageKey(STORAGE_KEY, scope);
        const onDeparture = vi.fn();
        window.addEventListener('thalassa:departure-changed', onDeparture);
        try {
            const { unmount } = render(<DepartControl />);
            const nextDate = localDate(Date.now() + 3 * 86_400_000);
            const dateInput = screen.getByLabelText('Departure date');
            const hourInput = screen.getByLabelText('Departure hour (24-hour)');
            const minuteInput = screen.getByLabelText('Departure minutes');

            fireEvent.change(dateInput, { target: { value: nextDate } });
            expect(localDate(Number(sessionStorage.getItem(key)))).toBe(nextDate);
            expect(onDeparture).toHaveBeenCalledTimes(1);
            fireEvent.change(hourInput, { target: { value: '14' } });
            expect(new Date(Number(sessionStorage.getItem(key))).getHours()).toBe(14);
            expect(onDeparture).toHaveBeenCalledTimes(2);
            fireEvent.change(minuteInput, { target: { value: '35' } });
            const plannedMs = new Date(`${nextDate}T14:35`).getTime();
            expect(sessionStorage.getItem(key)).toBe(String(plannedMs));
            expect(onDeparture).toHaveBeenCalledTimes(3);
            expect((onDeparture.mock.lastCall?.[0] as CustomEvent).detail).toEqual({
                ms: plannedMs,
                scopeKey: scope.key,
                scopeGeneration: scope.generation,
            });
            expect(dateInput).toHaveValue(nextDate);
            expect(hourInput).toHaveValue('14');
            expect(minuteInput).toHaveValue('35');
            expect(screen.queryByRole('button', { name: 'OK' })).not.toBeInTheDocument();

            dateInput.focus();
            fireEvent.click(screen.getByRole('button', { name: 'Now' }));
            expect(dateInput).not.toHaveFocus();
            expect(sessionStorage.getItem(key)).toBeNull();
            expect((onDeparture.mock.lastCall?.[0] as CustomEvent).detail).toEqual({
                ms: null,
                scopeKey: scope.key,
                scopeGeneration: scope.generation,
            });
            expect(screen.getByText('leaving now')).toBeInTheDocument();
            expect(screen.getByRole('button', { name: 'Now' })).toBeEnabled();

            unmount();
            render(<DepartControl />);
            expect(screen.getByText('leaving now')).toBeInTheDocument();
            expect(screen.getByLabelText('Departure date')).toHaveValue(localDate(Date.now()));
            expect(screen.getByRole('button', { name: 'Now' })).toBeEnabled();
            expect(screen.queryByRole('button', { name: 'OK' })).not.toBeInTheDocument();
            expect(sessionStorage.getItem(key)).toBeNull();
        } finally {
            window.removeEventListener('thalassa:departure-changed', onDeparture);
        }
    });
});
