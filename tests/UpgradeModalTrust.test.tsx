import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { UpgradeModal } from '../components/UpgradeModal';

describe('UpgradeModal purchase trust boundary', () => {
    it('presents free beta access without prices, purchase promises, or a trial countdown', () => {
        render(<UpgradeModal isOpen onClose={vi.fn()} />);

        expect(screen.getByRole('status')).toHaveTextContent(/unlocked at no charge/i);
        expect(screen.getByText(/free public beta/i)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /continue exploring/i })).toBeEnabled();
        expect(screen.queryByText(/\$\s*\d/)).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /purchase|subscribe|restore/i })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /start .*trial/i })).not.toBeInTheDocument();
    });
});
