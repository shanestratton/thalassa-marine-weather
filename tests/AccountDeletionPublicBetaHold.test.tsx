import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { UserSettings } from '../types';

const harness = vi.hoisted(() => ({
    deleteDialogRender: vi.fn(),
    invoke: vi.fn(),
}));

vi.mock('../services/accountDeletionPublicBetaBoundary', () => ({
    ACCOUNT_DELETION_PUBLIC_BETA_ENABLED: false,
    ACCOUNT_DELETION_PRIVACY_EMAIL: 'privacy@thalassawx.com',
    ACCOUNT_DELETION_PRIVACY_MAILTO:
        'mailto:privacy@thalassawx.com?subject=Thalassa%20public%20beta%20account%20deletion%20request',
    ACCOUNT_DELETION_PUBLIC_BETA_UNAVAILABLE_MESSAGE:
        'Account deletion is temporarily unavailable while its deletion safety controls are completed and verified. To request deletion during this beta, email privacy@thalassawx.com.',
}));

vi.mock('../context/ThalassaContext', () => ({
    useThalassa: () => ({
        user: { id: 'account-a', email: 'captain@example.com' },
        logout: vi.fn(),
    }),
}));

vi.mock('../services/weather/keys', () => ({
    checkStormglassStatus: vi.fn(async () => ({ status: 'MISSING_KEY', message: 'Free mode' })),
    isStormglassKeyPresent: vi.fn(() => false),
}));

vi.mock('../services/geminiService', () => ({ isGeminiConfigured: vi.fn(() => false) }));

vi.mock('../stores/authStore', () => ({
    useAuthStore: {
        getState: () => ({
            user: { id: 'account-a', email: 'captain@example.com' },
            authChecked: true,
        }),
        setState: vi.fn(),
    },
}));

vi.mock('../services/supabase', () => ({
    isSupabaseConfigured: vi.fn(() => true),
    supabase: {
        functions: { invoke: harness.invoke },
        auth: { signOut: vi.fn() },
    },
}));

vi.mock('../components/SignInScreen', () => ({ SignInScreen: () => null }));

vi.mock('../components/settings/DeleteAccountDialog', () => ({
    DeleteAccountDialog: () => {
        harness.deleteDialogRender();
        return null;
    },
}));

import { AccountTab } from '../components/settings/AccountTab';
import { deleteCurrentAccount } from '../services/accountDeletion';

describe('account deletion public-beta hold', () => {
    it('shows an honest privacy-contact boundary without rendering a destructive control or dialog', async () => {
        render(<AccountTab settings={{ satelliteMode: false } as UserSettings} onSave={vi.fn()} />);

        await screen.findByText('FREE MODE');
        expect(screen.getByText('Account deletion temporarily unavailable')).toBeInTheDocument();
        expect(screen.getByText(/destructive in-app flow is paused/i)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Permanently delete account' })).not.toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'privacy@thalassawx.com' })).toHaveAttribute(
            'href',
            expect.stringMatching(/^mailto:privacy@thalassawx\.com\?/),
        );
        expect(harness.deleteDialogRender).not.toHaveBeenCalled();
    });

    it('rejects at the service boundary before confirmation handling or the destructive Edge invocation', async () => {
        await expect(deleteCurrentAccount('delete')).rejects.toThrow(
            'Account deletion is temporarily unavailable while its deletion safety controls are completed and verified.',
        );
        expect(harness.invoke).not.toHaveBeenCalled();
    });
});
