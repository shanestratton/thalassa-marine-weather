import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
    signInWithOtp: vi.fn(async () => ({ error: null })),
    verifyOtp: vi.fn(async () => ({ error: null, data: { session: { access_token: 'test' } } })),
}));

vi.mock('../services/supabase', () => ({ supabase: { auth } }));
vi.mock('../hooks/useKeyboardOffset', () => ({ useKeyboardOffset: () => 0 }));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    getErrorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

import { AuthModal } from '../components/AuthModal';

describe('AuthModal email canonicalization', () => {
    it('uses the same sanitized address to send and verify an OTP', async () => {
        render(<AuthModal isOpen onClose={vi.fn()} />);

        const email = screen.getByRole('textbox', { name: /email address/i });
        fireEvent.change(email, { target: { value: ' Captain@\u200BExample.COM\u00A0' } });
        fireEvent.submit(email.closest('form') as HTMLFormElement);

        await waitFor(() =>
            expect(auth.signInWithOtp).toHaveBeenCalledWith(expect.objectContaining({ email: 'captain@example.com' })),
        );
        expect(await screen.findByText(/verification code to captain@example.com/i)).toBeInTheDocument();

        fireEvent.change(screen.getByRole('textbox', { name: /verification code/i }), {
            target: { value: '123456' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Verify email code' }));

        await waitFor(() =>
            expect(auth.verifyOtp).toHaveBeenCalledWith({
                email: 'captain@example.com',
                token: '123456',
                type: 'email',
            }),
        );
    });
});
