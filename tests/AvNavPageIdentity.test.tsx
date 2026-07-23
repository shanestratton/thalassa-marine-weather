import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const avNavMocks = vi.hoisted(() => ({
    configure: vi.fn(),
    connect: vi.fn(),
    getApiVersion: vi.fn(() => null),
    getCharts: vi.fn(() => []),
    getStatus: vi.fn(() => 'disconnected'),
    onChartsChange: vi.fn(() => vi.fn()),
    onStatusChange: vi.fn(() => vi.fn()),
    start: vi.fn(),
    stop: vi.fn(),
}));

const boatNetworkMocks = vi.hoisted(() => ({
    applyToServices: vi.fn(),
    scan: vi.fn(),
}));

const provisionMocks = vi.hoisted(() => ({
    provision: vi.fn(),
}));

const chartLockerMocks = vi.hoisted(() => ({
    deleteLocalChart: vi.fn(),
    downloadChart: vi.fn(),
    downloadToPhoneOnly: vi.fn(),
    getFullCatalog: vi.fn(() => []),
    getLocalCharts: vi.fn().mockResolvedValue([]),
    getRegions: vi.fn(() => []),
    pickAndSaveToPhone: vi.fn(),
    pickAndUpload: vi.fn(),
    uploadLocalChart: vi.fn(),
}));

vi.mock('../services/AvNavService', () => ({
    AvNavService: avNavMocks,
}));

vi.mock('../services/BoatNetworkService', () => ({
    BoatNetworkService: boatNetworkMocks,
    useBoatNetwork: () => ({
        piHost: 'calypso.local',
        services: [{ name: 'avnav-main', port: 8080 }],
        scanning: false,
        error: null,
    }),
}));

vi.mock('../services/PiProvisionService', () => ({
    DEFAULT_USERNAME: 'calypso',
    PiProvisionService: {
        isAvailable: true,
        provision: provisionMocks.provision,
    },
}));

vi.mock('../services/NmeaListenerService', () => ({
    NmeaListenerService: { configure: vi.fn(), start: vi.fn() },
}));
vi.mock('../services/NmeaStore', () => ({
    NmeaStore: { start: vi.fn() },
}));
vi.mock('../services/PiCacheService', () => ({
    piCache: { configure: vi.fn() },
}));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: { getState: () => ({ updateSettings: vi.fn() }) },
}));
vi.mock('../stores/LocationStore', () => ({
    LocationStore: { getState: () => ({ lat: -27.47, lon: 153.02 }) },
}));
vi.mock('../services/ChartLockerService', () => ({
    ChartLockerService: chartLockerMocks,
}));
vi.mock('../utils/system', () => ({
    triggerHaptic: vi.fn(),
}));
vi.mock('../components/vessel/EncCellManager', () => ({
    EncCellManager: () => null,
}));

import { AvNavPage } from '../components/vessel/AvNavPage';
import { setAuthIdentityScope } from '../services/authIdentityScope';

function openProvisioning(): { username: HTMLInputElement; password: HTMLInputElement } {
    fireEvent.click(screen.getByRole('button', { name: /Install Weather Cache/i }));
    return {
        username: screen.getByPlaceholderText('Username'),
        password: screen.getByPlaceholderText('Password'),
    };
}

describe('AvNavPage credential identity boundary', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
        localStorage.setItem('thalassa_avnav_setup_dismissed', 'true');
        setAuthIdentityScope(`avnav-a-${crypto.randomUUID()}`);
        chartLockerMocks.getLocalCharts.mockResolvedValue([]);
    });

    it('synchronously replaces account A SSH fields on an A→B transition', async () => {
        render(<AvNavPage onBack={vi.fn()} />);
        const { username, password } = openProvisioning();
        fireEvent.change(username, { target: { value: 'account-a-admin' } });
        fireEvent.change(password, { target: { value: 'account-a-ssh-secret' } });

        expect(username).toHaveValue('account-a-admin');
        expect(password).toHaveValue('account-a-ssh-secret');

        act(() => {
            setAuthIdentityScope(`avnav-b-${crypto.randomUUID()}`);
        });

        expect(screen.getByPlaceholderText('Username')).toHaveValue('calypso');
        expect(screen.getByPlaceholderText('Password')).toHaveValue('');
        expect(screen.queryByDisplayValue('account-a-admin')).not.toBeInTheDocument();
        expect(screen.queryByDisplayValue('account-a-ssh-secret')).not.toBeInTheDocument();
        await waitFor(() => expect(chartLockerMocks.getLocalCharts).toHaveBeenCalled());
    });

    it('scrubs the password when provisioning starts and ignores stale progress and success', async () => {
        let resolveProvision: ((result: { success: boolean }) => void) | undefined;
        provisionMocks.provision.mockReturnValue(
            new Promise<{ success: boolean }>((resolve) => {
                resolveProvision = resolve;
            }),
        );

        render(<AvNavPage onBack={vi.fn()} />);
        const { password } = openProvisioning();
        fireEvent.change(password, { target: { value: 'one-use-ssh-secret' } });
        fireEvent.click(screen.getByRole('button', { name: 'Install on Pi' }));

        expect(password).toHaveValue('');
        expect(provisionMocks.provision).toHaveBeenCalledOnce();
        expect(provisionMocks.provision.mock.calls[0]?.[2]).toBe('one-use-ssh-secret');
        const staleProgress = provisionMocks.provision.mock.calls[0]?.[3] as (progress: {
            phase: string;
            message: string;
        }) => void;

        act(() => {
            setAuthIdentityScope(`avnav-b-${crypto.randomUUID()}`);
            staleProgress({ phase: 'done', message: 'Account A completed' });
            resolveProvision?.({ success: true });
        });

        await waitFor(() => expect(boatNetworkMocks.scan).not.toHaveBeenCalled());
        expect(screen.queryByText('Account A completed')).not.toBeInTheDocument();
        expect(screen.getByPlaceholderText('Password')).toHaveValue('');
    });
});
