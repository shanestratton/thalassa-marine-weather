import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    redeemManifestCode: vi.fn(),
    requestFullReconciliation: vi.fn(),
}));

vi.mock('../services/supabase', () => ({
    supabase: {},
}));

vi.mock('../services/CrewService', () => ({
    redeemManifestCode: mocks.redeemManifestCode,
}));

vi.mock('../services/vessel/SyncService', () => ({
    requestFullReconciliation: mocks.requestFullReconciliation,
}));

vi.mock('../utils/system', () => ({
    triggerHaptic: vi.fn(),
}));

import { JoinVessel } from '../components/crew/JoinVessel';

describe('JoinVessel visibility reconciliation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.redeemManifestCode.mockResolvedValue({
            success: true,
            vesselName: 'Sea Glass',
        });
        mocks.requestFullReconciliation.mockResolvedValue({
            pushed: 0,
            pulled: 4,
            errors: [],
        });
    });

    it('forces a full reconciliation after a successful membership redemption', async () => {
        render(<JoinVessel onJoined={vi.fn()} onClose={vi.fn()} />);

        for (const [index, character] of Array.from('AB1234').entries()) {
            fireEvent.change(screen.getByRole('textbox', { name: `Code digit ${index + 1}` }), {
                target: { value: character },
            });
        }
        fireEvent.click(screen.getByRole('button', { name: '⚓ Join Vessel' }));

        await waitFor(() => expect(mocks.redeemManifestCode).toHaveBeenCalledWith('AB-1234'));
        await waitFor(() => expect(mocks.requestFullReconciliation).toHaveBeenCalledOnce());
        expect(screen.getByRole('heading', { name: 'Welcome Aboard' })).toBeInTheDocument();
        expect(screen.getByText('Sea Glass')).toBeInTheDocument();
    });
});
