import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { CrewCountProvider, useCrewCount } from '../contexts/CrewCountContext';
import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';

const CrewCountHarness: React.FC = () => {
    const { crewCount, setCrewCount } = useCrewCount();
    return (
        <div>
            <output aria-label="Crew count">{crewCount}</output>
            <button type="button" onClick={() => setCrewCount(crewCount + 1)}>
                Add crew
            </button>
        </div>
    );
};

describe('CrewCountContext account isolation', () => {
    beforeEach(() => {
        localStorage.clear();
        setAuthIdentityScope(null);
        setAuthIdentityScope('account-a');
    });

    it('switches in-memory and persisted counts with the authenticated identity', async () => {
        const accountAScope = getAuthIdentityScope();
        localStorage.setItem(authScopedStorageKey('thalassa_crew_count', accountAScope), '4');

        render(
            <CrewCountProvider>
                <CrewCountHarness />
            </CrewCountProvider>,
        );
        expect(screen.getByLabelText('Crew count')).toHaveTextContent('4');

        fireEvent.click(screen.getByRole('button', { name: 'Add crew' }));
        expect(screen.getByLabelText('Crew count')).toHaveTextContent('5');

        await act(async () => {
            setAuthIdentityScope('account-b');
        });
        expect(screen.getByLabelText('Crew count')).toHaveTextContent('2');
        fireEvent.click(screen.getByRole('button', { name: 'Add crew' }));
        expect(screen.getByLabelText('Crew count')).toHaveTextContent('3');

        await act(async () => {
            setAuthIdentityScope('account-a');
        });
        expect(screen.getByLabelText('Crew count')).toHaveTextContent('5');
        expect(localStorage.getItem(authScopedStorageKey('thalassa_crew_count', accountAScope))).toBe('5');
    });

    it('does not adopt the unattributable legacy crew count', () => {
        localStorage.setItem('thalassa_crew_count', '19');

        render(
            <CrewCountProvider>
                <CrewCountHarness />
            </CrewCountProvider>,
        );

        expect(screen.getByLabelText('Crew count')).toHaveTextContent('2');
    });
});
