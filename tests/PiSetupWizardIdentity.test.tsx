import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const provisioningMocks = vi.hoisted(() => ({
    configureNetwork: vi.fn(),
    isProvisioningReachable: vi.fn(),
    scanNetworks: vi.fn(),
    waitForJoinResolution: vi.fn(),
}));

const boatNetworkMocks = vi.hoisted(() => ({
    scan: vi.fn(),
    getState: vi.fn(() => ({ piHost: null })),
}));

vi.mock('../services/voice/piProvisioning', () => ({
    ...provisioningMocks,
    setupApContext: () => ({ host: '10.0.0.1', port: 5000 }),
}));

vi.mock('../services/BoatNetworkService', () => ({
    BoatNetworkService: boatNetworkMocks,
}));

import { PiSetupWizard } from '../components/voice/PiSetupWizard';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const accountANetwork = {
    ssid: 'Account A Boat WiFi',
    signal_dbm: -45,
    security: 'wpa2' as const,
    channel: 6,
};

async function reachPasswordStep(): Promise<HTMLInputElement> {
    fireEvent.click(screen.getByRole('button', { name: "I'm ready" }));
    fireEvent.click(screen.getByRole('button', { name: "I'm connected" }));
    await screen.findByRole('button', { name: /Account A Boat WiFi/ });
    fireEvent.click(screen.getByRole('button', { name: /Account A Boat WiFi/ }));
    return screen.getByPlaceholderText<HTMLInputElement>('Enter network password');
}

describe('PiSetupWizard identity boundary', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setAuthIdentityScope(`pi-wizard-a-${crypto.randomUUID()}`);
        provisioningMocks.isProvisioningReachable.mockResolvedValue(true);
        provisioningMocks.scanNetworks.mockResolvedValue([accountANetwork]);
        provisioningMocks.configureNetwork.mockResolvedValue({
            accepted: true,
            next_state: 'station_attempting',
            expected_settle_time_seconds: 5,
        });
    });

    it('synchronously hides account A Wi-Fi identifiers and password on A→B', async () => {
        render(<PiSetupWizard isOpen onClose={vi.fn()} />);
        const password = await reachPasswordStep();
        fireEvent.change(password, { target: { value: 'account-a-wifi-secret' } });

        expect(password).toHaveValue('account-a-wifi-secret');
        expect(screen.getByText('Password for Account A Boat WiFi')).toBeInTheDocument();

        act(() => {
            setAuthIdentityScope(`pi-wizard-b-${crypto.randomUUID()}`);
        });

        expect(screen.getByRole('button', { name: "I'm ready" })).toBeInTheDocument();
        expect(screen.queryByText(/Account A Boat WiFi/)).not.toBeInTheDocument();
        expect(screen.queryByDisplayValue('account-a-wifi-secret')).not.toBeInTheDocument();
        expect(screen.queryByPlaceholderText('Enter network password')).not.toBeInTheDocument();
    });

    it('drops a stale account A reachability result before scanning or updating account B', async () => {
        let resolveReachability: ((reachable: boolean) => void) | undefined;
        provisioningMocks.isProvisioningReachable.mockReturnValue(
            new Promise<boolean>((resolve) => {
                resolveReachability = resolve;
            }),
        );

        render(<PiSetupWizard isOpen onClose={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: "I'm ready" }));
        fireEvent.click(screen.getByRole('button', { name: "I'm connected" }));
        expect(screen.getByRole('status')).toHaveTextContent('Looking for the Pi');

        act(() => {
            setAuthIdentityScope(`pi-wizard-b-${crypto.randomUUID()}`);
            resolveReachability?.(true);
        });

        await waitFor(() => expect(provisioningMocks.scanNetworks).not.toHaveBeenCalled());
        expect(screen.getByRole('button', { name: "I'm ready" })).toBeInTheDocument();
        expect(screen.queryByText(/Account A Boat WiFi/)).not.toBeInTheDocument();
    });
});
