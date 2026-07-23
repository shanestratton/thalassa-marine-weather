import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../services/ChandleryBasketService', () => ({
    removeFromBasket: vi.fn(),
    setQuantity: vi.fn(),
}));

vi.mock('../utils/system', () => ({
    triggerHaptic: vi.fn(),
}));

import { BasketDrawer } from '../components/chandlery/BasketDrawer';

describe('BasketDrawer', () => {
    it('portals above app navigation and labels the unavailable checkout truthfully', () => {
        render(<BasketDrawer open onClose={vi.fn()} lines={[{ productId: 'copperhill-pican-m', quantity: 2 }]} />);

        const dialog = screen.getByRole('dialog', { name: 'Your Basket (2)' });
        expect(dialog.parentElement).toHaveClass('z-[1100]');
        expect(screen.getByText(/online checkout is not live yet/i)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Checkout unavailable, coming soon' })).toBeDisabled();
    });
});
