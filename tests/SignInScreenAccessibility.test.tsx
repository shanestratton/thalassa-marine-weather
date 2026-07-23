import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/auth/SocialAuthService', () => ({
    signInWithApple: vi.fn(),
    signInWithGoogle: vi.fn(),
}));

vi.mock('../stores/authStore', () => ({
    useAuthStore: (selector: (state: { user: null }) => unknown) => selector({ user: null }),
}));

vi.mock('../utils/system', () => ({
    triggerHaptic: vi.fn(),
}));

import { SignInScreen } from '../components/SignInScreen';

describe('SignInScreen accessibility', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('portals the controlled dialog, focuses its primary action, traps focus, and restores its launcher', () => {
        const onClose = vi.fn();
        const { container, rerender } = render(
            <>
                <button type="button">Open sign-in</button>
                <SignInScreen isOpen={false} onClose={onClose} />
            </>,
        );
        const launcher = screen.getByRole('button', { name: 'Open sign-in' });
        launcher.focus();

        rerender(
            <>
                <button type="button">Open sign-in</button>
                <SignInScreen isOpen onClose={onClose} />
            </>,
        );

        const dialog = screen.getByRole('dialog', { name: 'Sign in to Thalassa' });
        const primaryAction = screen.getByRole('button', { name: 'Sign in with email' });
        const closeAction = screen.getByRole('button', { name: 'Close sign-in' });
        const overlay = dialog.closest('[data-overlay-layer="modal"]');

        expect(overlay?.parentElement).toBe(document.body);
        expect(overlay).toHaveStyle({ zIndex: '1100' });
        expect(container).not.toContainElement(dialog);
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        expect(primaryAction).toHaveFocus();

        fireEvent.keyDown(primaryAction, { key: 'Tab' });
        expect(closeAction).toHaveFocus();
        fireEvent.keyDown(closeAction, { key: 'Tab', shiftKey: true });
        expect(primaryAction).toHaveFocus();

        fireEvent.keyDown(primaryAction, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledOnce();

        rerender(
            <>
                <button type="button">Open sign-in</button>
                <SignInScreen isOpen={false} onClose={onClose} />
            </>,
        );
        expect(screen.getByRole('button', { name: 'Open sign-in' })).toHaveFocus();
    });

    it('gives the legacy uncontrolled mode the same modal semantics and initial focus', () => {
        render(<SignInScreen />);

        const dialog = screen.getByRole('dialog', { name: 'Sign in to Thalassa' });
        expect(dialog.closest('[data-overlay-layer="modal"]')?.parentElement).toBe(document.body);
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        expect(screen.getByRole('button', { name: 'Sign in with email' })).toHaveFocus();
        expect(screen.queryByRole('button', { name: 'Close sign-in' })).not.toBeInTheDocument();
    });

    it('keeps the outer trap mounted beneath the nested email dialog and restores its action', () => {
        render(<SignInScreen isOpen onClose={vi.fn()} />);

        const primaryAction = screen.getByRole('button', { name: 'Sign in with email' });
        fireEvent.click(primaryAction);

        const nestedDialog = screen.getByRole('dialog', { name: 'Sync Your Logs' });
        const nestedOverlay = nestedDialog.closest('[data-overlay-layer="nested"]');
        const outerDialog = document.querySelector<HTMLElement>('[aria-labelledby="sign-in-title"]');

        expect(nestedOverlay?.parentElement).toBe(document.body);
        expect(nestedOverlay).toHaveStyle({ zIndex: '1200' });
        expect(outerDialog).toHaveAttribute('aria-hidden', 'true');
        expect(outerDialog).not.toHaveAttribute('aria-modal');
        expect(screen.getByRole('button', { name: 'Close authentication dialog' })).toHaveFocus();

        fireEvent.click(screen.getByRole('button', { name: 'Close authentication dialog' }));

        expect(screen.queryByRole('dialog', { name: 'Sync Your Logs' })).not.toBeInTheDocument();
        expect(outerDialog).not.toHaveAttribute('aria-hidden');
        expect(outerDialog).toHaveAttribute('aria-modal', 'true');
        expect(primaryAction).toHaveFocus();
    });

    it('renders its portal fallback safely during SSR', () => {
        const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
        Object.defineProperty(globalThis, 'document', {
            configurable: true,
            value: undefined,
        });

        try {
            const html = renderToString(<SignInScreen />);
            expect(html).toContain('data-overlay-layer="modal"');
            expect(html).toContain('role="dialog"');
            expect(html).toContain('Sign in to Thalassa');
        } finally {
            if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor);
        }
    });
});
