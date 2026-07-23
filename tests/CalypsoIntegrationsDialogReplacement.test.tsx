import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserSettings } from '../types/settings';
import { setAuthIdentityScope } from '../services/authIdentityScope';

type UrlOpenListener = (event: { url?: string }) => void;
type BrowserFinishedListener = () => void;

const mocks = vi.hoisted(() => ({
    appUrlOpen: null as UrlOpenListener | null,
    browserFinished: null as BrowserFinishedListener | null,
    browserOpen: vi.fn(),
    browserClose: vi.fn(),
    beginAuthorization: vi.fn(),
    clearGmailTokens: vi.fn(),
    completeAuthorization: vi.fn(),
    extractAuthCallbackFromUrl: vi.fn(),
    getConnectedEmail: vi.fn(),
    isGmailConfigured: vi.fn(),
}));

vi.mock('@capacitor/app', () => ({
    App: {
        addListener: vi.fn(async (event: string, callback: UrlOpenListener) => {
            if (event === 'appUrlOpen') mocks.appUrlOpen = callback;
            return { remove: vi.fn(async () => undefined) };
        }),
    },
}));

vi.mock('@capacitor/browser', () => ({
    Browser: {
        open: mocks.browserOpen,
        close: mocks.browserClose,
        addListener: vi.fn(async (event: string, callback: BrowserFinishedListener) => {
            if (event === 'browserFinished') mocks.browserFinished = callback;
            return { remove: vi.fn(async () => undefined) };
        }),
    },
}));

vi.mock('../services/SubscriptionService', () => ({ canAccess: vi.fn(() => true) }));
vi.mock('../services/voice/integrations/gmail', () => ({
    beginAuthorization: mocks.beginAuthorization,
    clearGmailTokens: mocks.clearGmailTokens,
    completeAuthorization: mocks.completeAuthorization,
    extractAuthCallbackFromUrl: mocks.extractAuthCallbackFromUrl,
    getConnectedEmail: mocks.getConnectedEmail,
    isGmailConfigured: mocks.isGmailConfigured,
}));
vi.mock('../services/AlertMonitorService', () => ({
    AlertMonitorService: { fireTestAlert: vi.fn() },
}));
vi.mock('../services/voice/ttsClient', () => ({
    speak: vi.fn(() => ({ done: Promise.resolve() })),
}));
vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));

import { CalypsoIntegrationsTab } from '../components/settings/CalypsoIntegrationsTab';

function settings(overrides: Partial<UserSettings> = {}): UserSettings {
    return {
        subscriptionTier: 'owner',
        calypsoEmailEnabled: false,
        ...overrides,
    } as UserSettings;
}

describe('Calypso Gmail app-native status handling', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.appUrlOpen = null;
        mocks.browserFinished = null;
        mocks.browserOpen.mockResolvedValue(undefined);
        mocks.browserClose.mockResolvedValue(undefined);
        mocks.beginAuthorization.mockResolvedValue('https://accounts.google.test/oauth');
        mocks.clearGmailTokens.mockResolvedValue(true);
        mocks.completeAuthorization.mockResolvedValue('skipper@example.com');
        mocks.extractAuthCallbackFromUrl.mockReturnValue({ code: 'oauth-code', state: 'oauth-state' });
        mocks.getConnectedEmail.mockResolvedValue(null);
        mocks.isGmailConfigured.mockResolvedValue(true);
        setAuthIdentityScope('calypso-user');
    });

    it('deduplicates connect attempts and announces missing configuration inline', async () => {
        let finishBegin!: (url: string | null) => void;
        mocks.beginAuthorization.mockReturnValue(
            new Promise((resolve) => {
                finishBegin = resolve;
            }),
        );
        const onSave = vi.fn();
        render(<CalypsoIntegrationsTab settings={settings()} onSave={onSave} />);

        const toggle = await screen.findByRole('switch', { name: 'Gmail access' });
        fireEvent.click(toggle);
        fireEvent.click(toggle);
        expect(mocks.beginAuthorization).toHaveBeenCalledTimes(1);

        await act(async () => {
            finishBegin(null);
        });

        expect(await screen.findByRole('alert')).toHaveTextContent('Gmail integration is not configured');
        expect(onSave).toHaveBeenCalledWith({ calypsoEmailEnabled: false });
        expect(mocks.browserOpen).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: 'Dismiss Gmail error' }));
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('unlocks cleanly when the OAuth browser is cancelled', async () => {
        const onSave = vi.fn();
        render(<CalypsoIntegrationsTab settings={settings()} onSave={onSave} />);
        const toggle = await screen.findByRole('switch', { name: 'Gmail access' });
        await waitFor(() => expect(mocks.getConnectedEmail).toHaveBeenCalled());
        onSave.mockClear();

        fireEvent.click(toggle);
        await waitFor(() => expect(mocks.browserOpen).toHaveBeenCalledTimes(1));
        expect(screen.getByText(/Connecting — finish signing in/i)).toBeInTheDocument();
        expect(mocks.browserFinished).not.toBeNull();

        act(() => mocks.browserFinished?.());
        expect(screen.queryByText(/Connecting — finish signing in/i)).not.toBeInTheDocument();
        expect(onSave).not.toHaveBeenCalled();

        fireEvent.click(toggle);
        await waitFor(() => expect(mocks.beginAuthorization).toHaveBeenCalledTimes(2));
    });

    it('catches OAuth callback failures and exposes a retryable inline error', async () => {
        mocks.completeAuthorization.mockRejectedValue(new Error('token exchange rejected'));
        const onSave = vi.fn();
        render(<CalypsoIntegrationsTab settings={settings()} onSave={onSave} />);

        fireEvent.click(await screen.findByRole('switch', { name: 'Gmail access' }));
        await waitFor(() => expect(mocks.browserOpen).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(mocks.appUrlOpen).not.toBeNull());
        act(() => {
            mocks.appUrlOpen?.({ url: 'com.googleusercontent.apps.test:/oauth2redirect?code=oauth-code' });
        });

        expect(await screen.findByRole('alert')).toHaveTextContent(
            'Gmail authorisation failed: token exchange rejected',
        );
        expect(onSave).toHaveBeenCalledWith({ calypsoEmailEnabled: false });

        fireEvent.click(screen.getByRole('switch', { name: 'Gmail access' }));
        await waitFor(() => expect(mocks.beginAuthorization).toHaveBeenCalledTimes(2));
    });

    it('keeps Gmail enabled and announces a failed disconnect', async () => {
        mocks.getConnectedEmail.mockResolvedValue('skipper@example.com');
        mocks.clearGmailTokens.mockResolvedValue(false);
        const onSave = vi.fn();
        render(
            <CalypsoIntegrationsTab
                settings={settings({
                    calypsoEmailEnabled: true,
                    calypsoEmailAccount: 'skipper@example.com',
                })}
                onSave={onSave}
            />,
        );

        fireEvent.click(await screen.findByRole('switch', { name: 'Gmail access' }));

        expect(await screen.findByRole('alert')).toHaveTextContent(
            'Gmail disconnection failed: could not clear the account-scoped Gmail credentials',
        );
        expect(onSave).not.toHaveBeenCalledWith({
            calypsoEmailEnabled: false,
            calypsoEmailAccount: undefined,
        });
    });
});
