import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@supabase/supabase-js';
import type { UserSettings } from '../types';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const mocks = vi.hoisted(() => ({
    fetch: vi.fn(),
    purgeCache: vi.fn(),
    status: {
        reachable: true,
        discoveredVia: 'calypso.local',
        latencyMs: 12,
        cacheStats: null,
    },
}));

vi.mock('../stores/authStore', async () => {
    const { create } = await import('zustand');
    const useAuthStore = create<{ user: User | null }>()(() => ({ user: null }));
    return { useAuthStore };
});

vi.mock('../services/PiCacheService', () => ({
    piCache: {
        configure: vi.fn(),
        onStatusChange: vi.fn(() => vi.fn()),
        getStatus: vi.fn(() => mocks.status),
        fetch: mocks.fetch,
        purgeCache: mocks.purgeCache,
        ping: vi.fn(async () => mocks.status),
        discover: vi.fn(async () => mocks.status),
        pushConfig: vi.fn(async () => true),
    },
}));

vi.mock('../services/SubscriptionService', () => ({
    canAccess: vi.fn(() => true),
}));

vi.mock('../stores/LocationStore', () => ({
    LocationStore: {
        getState: vi.fn(() => ({ lat: -27.4, lon: 153.1 })),
    },
}));

vi.mock('../services/PiProvisionService', () => ({
    DEFAULT_USERNAME: 'pi',
    PiProvisionService: {
        isAvailable: true,
        provision: vi.fn(),
    },
}));

vi.mock('../services/BoatNetworkService', () => ({
    BoatNetworkService: {
        scan: vi.fn(async () => null),
        applyToServices: vi.fn(),
    },
    useBoatNetwork: () => ({
        piHost: 'calypso.local',
        services: [],
    }),
}));

vi.mock('../utils/system', () => ({
    triggerHaptic: vi.fn(),
}));

import { useAuthStore } from '../stores/authStore';
import { PiCacheTab } from '../components/settings/PiCacheTab';

const accountA = { id: 'account-a' } as User;
const accountB = { id: 'account-b' } as User;
const settings = {
    subscriptionTier: 'skipper',
    piCacheEnabled: true,
    piCacheHost: 'calypso.local',
    piCachePort: 3001,
} as unknown as UserSettings;

function switchAccount(user: User): void {
    setAuthIdentityScope(user.id);
    useAuthStore.setState({ user });
}

describe('PiCacheTab identity lifecycle', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setAuthIdentityScope(null);
        switchAccount(accountA);
        mocks.status.reachable = true;
        mocks.fetch.mockResolvedValue({ source: 'pi', data: {} });
    });

    it('drops a test result that resolves after account A switches to B', async () => {
        let resolveFetch!: (value: { source: string; data: object }) => void;
        mocks.fetch.mockReturnValueOnce(
            new Promise((resolve) => {
                resolveFetch = resolve;
            }),
        );
        render(<PiCacheTab settings={settings} onSave={vi.fn()} />);

        fireEvent.click(screen.getByRole('button', { name: 'Test Data Fetch' }));
        expect(screen.getByRole('button', { name: 'Testing...' })).toBeDisabled();

        act(() => switchAccount(accountB));
        expect(screen.getByRole('button', { name: 'Test Data Fetch' })).toBeEnabled();

        await act(async () => {
            resolveFetch({ source: 'pi', data: {} });
            await Promise.resolve();
        });

        expect(screen.queryByText(/Weather fetched from Pi/)).not.toBeInTheDocument();
    });

    it('synchronously removes account A SSH credentials on an identity transition', () => {
        mocks.status.reachable = false;
        render(<PiCacheTab settings={settings} onSave={vi.fn()} />);

        fireEvent.click(screen.getByRole('button', { name: 'Install on Pi' }));
        const password = screen.getByPlaceholderText('Your Pi password');
        fireEvent.change(password, { target: { value: 'account-a-secret' } });
        expect(password).toHaveValue('account-a-secret');

        act(() => switchAccount(accountB));

        expect(screen.queryByPlaceholderText('Your Pi password')).not.toBeInTheDocument();
        expect(screen.queryByDisplayValue('account-a-secret')).not.toBeInTheDocument();
    });
});
