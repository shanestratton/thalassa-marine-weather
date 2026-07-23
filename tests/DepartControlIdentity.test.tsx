import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';

vi.mock('../utils/system', () => ({
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
});
