import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserSettings } from '../types';

const m = vi.hoisted(() => {
    vi.stubEnv('VITE_APPLE_SIGN_IN_ENABLED', 'true');
    return { keyboard: 0, send: vi.fn(), verify: vi.fn(), apple: vi.fn(), google: vi.fn() };
});
vi.mock('@capacitor/core', () => ({
    Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios', isPluginAvailable: () => false },
    registerPlugin: vi.fn(() => ({})),
}));
vi.mock('../services/auth/SocialAuthService', () => ({
    APPLE_WEB_SIGN_IN_ENABLED: true,
    signInWithApple: m.apple,
    signInWithAppleOnWeb: m.apple,
}));
vi.mock('../services/auth/googleSignIn', () => ({
    GOOGLE_SIGN_IN_ENABLED: true,
    signInWithGoogle: m.google,
    signInWithGoogleOnWeb: m.google,
}));
vi.mock('../stores/authStore', () => ({
    useAuthStore: (selector: (state: { user: null }) => unknown) => selector({ user: null }),
}));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: null, logout: vi.fn() }) }));
vi.mock('../hooks/useKeyboardOffset', () => ({ useKeyboardOffset: () => m.keyboard }));
vi.mock('../services/supabase', () => ({
    isSupabaseConfigured: () => true,
    supabase: { auth: { signInWithOtp: m.send, verifyOtp: m.verify } },
}));
vi.mock('../services/weather/keys', () => ({
    checkStormglassStatus: vi.fn(async () => ({ status: 'OK', message: 'Ready' })),
    isStormglassKeyPresent: () => true,
}));
vi.mock('../services/geminiService', () => ({ isGeminiConfigured: () => true }));
// The charts line in Cloud Data is a plain sentence since 126-20 (no cloud
// read), so the real panel renders here: no stand-in needed.
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));
import { AccountTab } from '../components/settings/AccountTab';
import { SignInScreen } from '../components/SignInScreen';

const account = () => <AccountTab settings={{ satelliteMode: false } as UserSettings} onSave={vi.fn()} />;
beforeEach(() => {
    vi.clearAllMocks();
    m.keyboard = 0;
    m.send.mockResolvedValue({ error: null });
    m.verify.mockResolvedValue({ error: null, data: { session: { access_token: 'test-session' } } });
});
afterAll(() => vi.unstubAllEnvs());

describe('Account & Cloud sign-in choices', () => {
    it('opens all three equally clear methods from the generic Sign in CTA, without starting authentication', async () => {
        render(account());
        const launch = screen.getByRole('button', { name: 'Sign in' });
        expect(screen.queryByRole('button', { name: 'Sign in with email' })).not.toBeInTheDocument();
        fireEvent.click(launch);
        const chooser = screen.getByRole('dialog', { name: 'Sign in to Thalassa' });
        const options = ['Sign in with Apple', 'Sign in with Google', 'Sign in with email'];
        for (const name of options) expect(within(chooser).getByRole('button', { name })).toHaveClass('w-full', 'h-12');
        expect(screen.queryByRole('button', { name: 'Use email instead' })).not.toBeInTheDocument();
        expect(screen.queryByRole('textbox', { name: 'Email address' })).not.toBeInTheDocument();
        expect(m.send).not.toHaveBeenCalled();
        expect(m.apple).not.toHaveBeenCalled();
        expect(m.google).not.toHaveBeenCalled();
        await waitFor(() => expect(screen.queryByText('Checking…')).not.toBeInTheDocument());
    });
    it('opens and focuses the existing passwordless email form, then returns to the email choice', () => {
        render(<SignInScreen isOpen onClose={vi.fn()} />);
        const emailChoice = screen.getByRole('button', { name: 'Sign in with email' });
        fireEvent.click(emailChoice);
        const email = screen.getByRole('textbox', { name: 'Email address' });
        expect(email).toHaveFocus();
        expect(email).toHaveAttribute('autocomplete', 'email');
        expect(email).toHaveAttribute('inputmode', 'email');
        expect(email).toHaveClass('text-base');
        expect(screen.getByText(/No password needed/)).toBeVisible();
        fireEvent.click(screen.getByRole('button', { name: 'Close authentication dialog' }));
        expect(emailChoice).toHaveFocus();
        expect(screen.getByRole('button', { name: 'Sign in with Apple' })).toBeVisible();
        expect(screen.getByRole('button', { name: 'Sign in with Google' })).toBeVisible();
    });
    it('keeps the email and code forms within a bounded scrollable panel while the keyboard is open', async () => {
        m.keyboard = 340;
        render(<SignInScreen isOpen onClose={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Sign in with email' }));
        const email = screen.getByRole('textbox', { name: 'Email address' });
        const panel = email.closest('.tablet-modal');
        expect(panel).toHaveClass('min-h-0', 'max-h-full', 'overflow-y-auto');
        expect(email).toHaveFocus();
        expect(screen.getByRole('button', { name: 'Send code' })).toBeVisible();
        fireEvent.change(email, { target: { value: 'skipper@example.com' } });
        fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
        await waitFor(() =>
            expect(m.send).toHaveBeenCalledWith({ email: 'skipper@example.com', options: { shouldCreateUser: true } }),
        );
        const otp = await screen.findByRole('textbox', { name: 'Verification code' });
        expect(otp).toHaveFocus();
        expect(otp).toHaveAttribute('autocomplete', 'one-time-code');
        expect(screen.getByRole('button', { name: /^Resend in \d+s$/ })).toBeDisabled();
        fireEvent.click(screen.getByRole('button', { name: 'Change email' }));
        expect(screen.getByRole('textbox', { name: 'Email address' })).toHaveValue('skipper@example.com');
        expect(m.verify).not.toHaveBeenCalled();
    });
    it('starts with the method chooser on reopening, not a previous unfinished email step', () => {
        const close = vi.fn();
        const view = render(<SignInScreen isOpen onClose={close} />);
        fireEvent.click(screen.getByRole('button', { name: 'Sign in with email' }));
        view.rerender(<SignInScreen isOpen={false} onClose={close} />);
        view.rerender(<SignInScreen isOpen onClose={close} />);
        expect(screen.getByRole('dialog', { name: 'Sign in to Thalassa' })).toBeVisible();
        expect(screen.queryByRole('textbox', { name: 'Email address' })).not.toBeInTheDocument();
        expect(m.send).not.toHaveBeenCalled();
    });
});
