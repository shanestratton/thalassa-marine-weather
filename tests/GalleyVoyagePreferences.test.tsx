import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PassageStatus } from '../services/PassagePlanService';
import type { Voyage } from '../services/VoyageService';
import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';

const mocks = vi.hoisted(() => ({
    getCrewCount: vi.fn(),
    getVoyageById: vi.fn(),
}));

vi.mock('../services/MealPlanService', () => ({
    getMealsByStatus: vi.fn(() => []),
    calculateMealDays: vi.fn(() => ({
        passageDays: 2,
        emergencyDays: 0,
        totalDays: 2,
        dates: ['2026-07-23', '2026-07-24'],
        emergencyDates: new Set<string>(),
    })),
    getCrewCount: mocks.getCrewCount,
}));

vi.mock('../services/ShoppingListService', () => ({
    getShoppingList: vi.fn(() => ({
        total: 0,
        purchased: 0,
        remaining: 0,
        totalCost: 0,
        currency: 'AUD',
        zones: [],
    })),
    markPurchased: vi.fn(),
}));

vi.mock('../services/VoyageService', () => ({
    getCachedActiveVoyage: vi.fn(() => null),
    getVoyageById: mocks.getVoyageById,
}));

vi.mock('../services/PurchaseUnits', () => ({
    toPurchasable: vi.fn(),
}));

vi.mock('../contexts/CrewCountContext', () => ({
    useCrewCount: () => ({
        crewCount: 2,
        setCrewCount: vi.fn(),
    }),
}));

vi.mock('../utils/system', () => ({
    triggerHaptic: vi.fn(),
}));

vi.mock('../components/chat/MealCalendar', () => ({
    MealCalendar: ({
        crewCount,
        onCrewCountChange,
    }: {
        crewCount: number;
        onCrewCountChange?: (count: number) => void;
    }) => (
        <div>
            <output data-testid="galley-crew-count">{crewCount}</output>
            <button type="button" onClick={() => onCrewCountChange?.(7)}>
                Plan for seven
            </button>
        </div>
    ),
}));

vi.mock('../components/chat/CaptainsTable', () => ({
    CaptainsTable: () => <div>Recipes</div>,
}));

import { GalleyCard } from '../components/chat/GalleyCard';

const voyage = (id: string): Voyage => ({
    id,
    user_id: 'captain-1',
    vessel_id: null,
    voyage_name: `Voyage ${id}`,
    departure_port: 'Brisbane',
    destination_port: 'Noumea',
    departure_time: '2026-07-23T00:00:00.000Z',
    eta: '2026-07-25T00:00:00.000Z',
    crew_count: 2,
    status: 'planning',
    weather_master_id: 'captain-1',
    notes: null,
    created_at: '2026-07-23T00:00:00.000Z',
    updated_at: '2026-07-23T00:00:00.000Z',
});

const passageStatus = (voyageId: string): PassageStatus => ({
    visible: true,
    voyageId,
    ownerUserId: 'captain-1',
    isOwner: true,
    canEditStores: true,
    canViewMeals: true,
    canViewChat: true,
    canViewRoute: true,
    canViewChecklist: true,
});

async function openMealPlanner(): Promise<void> {
    fireEvent.click(screen.getByRole('button', { name: /Voyage Provisioning/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Meal Planner/ }));
}

describe('Galley voyage preferences', () => {
    beforeEach(() => {
        localStorage.clear();
        setAuthIdentityScope(null);
        setAuthIdentityScope('account-a');
        vi.clearAllMocks();
        mocks.getVoyageById.mockImplementation(async (voyageId: string) => voyage(voyageId));
        mocks.getCrewCount.mockImplementation(async (voyageId: string) => (voyageId === 'voyage-1' ? 5 : 3));
    });

    it('isolates the provisioned flag by both account and voyage', async () => {
        const { rerender } = render(<GalleyCard passageStatus={passageStatus('voyage-1')} />);
        fireEvent.click(screen.getByRole('button', { name: /Voyage Provisioning/ }));
        fireEvent.click(screen.getByRole('button', { name: 'All meals provisioned for this voyage' }));

        const accountAScope = getAuthIdentityScope();
        expect(localStorage.getItem(authScopedStorageKey('thalassa_provisioned:voyage-1', accountAScope))).toBe('true');
        expect(screen.getByText('✅ Provisioned')).toBeInTheDocument();

        rerender(<GalleyCard passageStatus={passageStatus('voyage-2')} />);
        await waitFor(() => expect(screen.getByText('Meals · Shopping')).toBeInTheDocument());

        await act(async () => {
            setAuthIdentityScope('account-b');
        });
        rerender(<GalleyCard passageStatus={passageStatus('voyage-1')} />);
        await waitFor(() => expect(screen.getByText('Meals · Shopping')).toBeInTheDocument());

        await act(async () => {
            setAuthIdentityScope('account-a');
        });
        await waitFor(() => expect(screen.getByText('✅ Provisioned')).toBeInTheDocument());
    });

    it('loads and persists crew planning independently for each voyage', async () => {
        const { rerender } = render(<GalleyCard passageStatus={passageStatus('voyage-1')} />);
        await openMealPlanner();

        await waitFor(() => expect(screen.getByTestId('galley-crew-count')).toHaveTextContent('5'));
        fireEvent.click(screen.getByRole('button', { name: 'Plan for seven' }));
        expect(screen.getByTestId('galley-crew-count')).toHaveTextContent('7');
        expect(localStorage.getItem(authScopedStorageKey('thalassa_galley_crew_count:voyage-1'))).toBe('7');

        rerender(<GalleyCard passageStatus={passageStatus('voyage-2')} />);
        await waitFor(() => expect(screen.getByTestId('galley-crew-count')).toHaveTextContent('3'));

        rerender(<GalleyCard passageStatus={passageStatus('voyage-1')} />);
        await waitFor(() => expect(screen.getByTestId('galley-crew-count')).toHaveTextContent('7'));
    });
});
