import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@capacitor/core', () => ({
    Capacitor: { isNativePlatform: () => true },
}));
vi.mock('../services/VoyageLogService', () => ({
    VoyageLogService: { getConfig: vi.fn().mockResolvedValue({ handle: 'wanderer' }) },
}));
vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));

import { PlanOnWebHint } from '../components/passage/PlanOnWebHint';

describe('PlanOnWebHint', () => {
    beforeEach(() => localStorage.clear());

    it('contains focus, closes with Escape, and restores the planner control', async () => {
        const { rerender } = render(<button>Open passage planner</button>);
        const opener = screen.getByRole('button', { name: 'Open passage planner' });
        opener.focus();

        rerender(
            <>
                <button>Open passage planner</button>
                <PlanOnWebHint />
            </>,
        );
        const close = await screen.findByRole('button', { name: 'Got it — plot here anyway' });
        await waitFor(() => expect(close).toHaveFocus());
        expect(screen.getByRole('dialog', { name: /Plot on the big screen/ })).toContainElement(close);

        fireEvent.keyDown(close, { key: 'Escape' });
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(opener).toHaveFocus();
    });
});
