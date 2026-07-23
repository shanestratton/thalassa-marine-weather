import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../services/weather/ModelSpreadService', () => ({
    queryModelSpread: vi.fn().mockResolvedValue({ atmos: null, marine: null }),
}));
vi.mock('../stores/LocationStore', () => ({
    useLocationCoords: () => ({ lat: -27.47, lon: 153.02 }),
}));

import { BasketDrawer } from '../components/chandlery/BasketDrawer';
import { ChannelProposalModal } from '../components/chat/ChannelProposalModal';
import { ModelComparisonMatrix } from '../components/dashboard/ModelComparisonMatrix';
import { RainForecastCard } from '../components/dashboard/RainForecastCard';
import { CheckoutModal } from '../components/marketplace/CheckoutModal';
import { ServiceLogSheet } from '../components/vessel/maintenance/ServiceLogSheet';
import { PiSetupWizard } from '../components/voice/PiSetupWizard';
import type { MarketplaceListing } from '../services/MarketplaceService';
import type { TaskWithStatus } from '../services/MaintenanceService';

function expectModalBodyPortal(element: HTMLElement) {
    const portal = element.closest<HTMLElement>('[data-overlay-layer="modal"]');
    expect(portal).not.toBeNull();
    expect(portal?.parentElement).toBe(document.body);
    expect(portal).toHaveStyle({ zIndex: '1100' });
}

describe('direct dialog accessibility', () => {
    it('contains the basket and restores focus to its opener', () => {
        const onClose = vi.fn();
        const { rerender } = render(
            <>
                <button>Open basket</button>
                <BasketDrawer open={false} onClose={onClose} lines={[]} />
            </>,
        );
        const opener = screen.getByRole('button', { name: 'Open basket' });
        opener.focus();

        rerender(
            <>
                <button>Open basket</button>
                <BasketDrawer open onClose={onClose} lines={[]} />
            </>,
        );
        const close = screen.getByRole('button', { name: 'Close basket' });
        expect(screen.getByRole('dialog', { name: 'Your Basket (0)' })).toContainElement(close);
        expect(close).toHaveFocus();
        fireEvent.keyDown(close, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledOnce();

        rerender(
            <>
                <button>Open basket</button>
                <BasketDrawer open={false} onClose={onClose} lines={[]} />
            </>,
        );
        expect(opener).toHaveFocus();
    });

    it('focuses the channel name and closes the proposal wizard with Escape', () => {
        const onClose = vi.fn();
        render(
            <ChannelProposalModal
                onClose={onClose}
                proposalIcon=""
                setProposalIcon={vi.fn()}
                proposalName=""
                setProposalName={vi.fn()}
                proposalDesc=""
                setProposalDesc={vi.fn()}
                proposalIsPrivate={false}
                setProposalIsPrivate={vi.fn()}
                proposalSent={false}
                onProposeChannel={vi.fn()}
                parentOptions={[]}
                proposalParentId={null}
                setProposalParentId={vi.fn()}
            />,
        );
        const name = screen.getByRole('textbox', { name: 'Channel name' });
        expectModalBodyPortal(screen.getByRole('dialog', { name: 'New Channel' }));
        expect(name).toHaveFocus();
        fireEvent.keyDown(name, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledOnce();
    });

    it('provides a visible, keyboard-safe close action for marketplace checkout', () => {
        const listing: MarketplaceListing = {
            id: 'listing-1',
            seller_id: 'seller-1',
            title: 'Manson Supreme Anchor',
            description: null,
            price: 850,
            currency: 'AUD',
            category: 'Hardware',
            condition: 'Used - Good',
            images: [],
            location_name: 'Brisbane',
            status: 'available',
            sold_at: null,
            created_at: '2026-07-23T00:00:00Z',
            updated_at: '2026-07-23T00:00:00Z',
        };
        const onClose = vi.fn();
        render(<CheckoutModal listing={listing} isOpen onClose={onClose} onCashDeal={vi.fn()} />);
        const close = screen.getByRole('button', { name: 'Close marketplace checkout' });
        expect(close).toHaveFocus();
        fireEvent.keyDown(close, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledOnce();
    });

    it('contains model comparison and restores its opener', () => {
        const onClose = vi.fn();
        const { rerender } = render(
            <>
                <button>Compare models</button>
                <ModelComparisonMatrix visible={false} onClose={onClose} selectedModel="best_match" />
            </>,
        );
        const opener = screen.getByRole('button', { name: 'Compare models' });
        opener.focus();

        rerender(
            <>
                <button>Compare models</button>
                <ModelComparisonMatrix visible onClose={onClose} selectedModel="best_match" />
            </>,
        );
        const close = screen.getByRole('button', { name: 'Close' });
        expect(screen.getByRole('dialog', { name: 'Model Convergence' })).toContainElement(close);
        expect(close).toHaveFocus();

        rerender(
            <>
                <button>Compare models</button>
                <ModelComparisonMatrix visible={false} onClose={onClose} selectedModel="best_match" />
            </>,
        );
        expect(opener).toHaveFocus();
    });

    it('restores the prior scroll lock and opener when rain detail closes', () => {
        const priorOverflow = document.body.style.overflow;
        document.body.style.overflow = 'clip';
        const future = new Date(Date.now() + 60_000).toISOString();
        const { unmount } = render(<RainForecastCard data={[{ time: future, intensity: 1.2 }]} />);
        const opener = screen.getByRole('button', { name: 'Open rain forecast detail' });
        opener.focus();
        fireEvent.click(opener);

        const close = screen.getByRole('button', { name: 'Close rain forecast detail' });
        expectModalBodyPortal(screen.getByRole('dialog', { name: 'Rain Forecast' }));
        expect(close).toHaveFocus();
        expect(document.body.style.overflow).toBe('hidden');
        fireEvent.keyDown(close, { key: 'Escape' });
        expect(screen.queryByRole('dialog', { name: 'Rain Forecast' })).not.toBeInTheDocument();
        expect(document.body.style.overflow).toBe('clip');
        expect(opener).toHaveFocus();

        unmount();
        document.body.style.overflow = priorOverflow;
    });

    it('contains maintenance service logging and Pi setup', () => {
        const task = {
            id: 'task-1',
            title: 'Change engine oil',
            status: 'yellow',
            statusLabel: 'Due in 5 hrs',
            daysRemaining: null,
            hoursRemaining: 5,
            trigger_type: 'engine_hours',
            is_active: true,
        } as TaskWithStatus;
        const closeService = vi.fn();
        const { unmount } = render(
            <ServiceLogSheet
                task={task}
                engineHours={1200}
                notes=""
                onNotesChange={vi.fn()}
                saving={false}
                onLog={vi.fn()}
                onHistory={vi.fn()}
                onEdit={vi.fn()}
                onClose={closeService}
            />,
        );
        const serviceClose = screen.getByRole('button', { name: 'Close service sheet' });
        expectModalBodyPortal(screen.getByRole('dialog', { name: 'Change engine oil' }));
        expect(serviceClose).toHaveFocus();
        fireEvent.keyDown(serviceClose, { key: 'Escape' });
        expect(closeService).toHaveBeenCalledOnce();
        unmount();

        const closeSetup = vi.fn();
        render(<PiSetupWizard isOpen onClose={closeSetup} />);
        const setupClose = screen.getByRole('button', { name: 'Close setup' });
        const setupDialog = screen.getByRole('dialog', { name: 'Set up Pi' });
        expect(setupDialog).toContainElement(setupClose);
        expectModalBodyPortal(setupDialog);
        expect(setupClose).toHaveFocus();
        fireEvent.click(screen.getByRole('button', { name: "I'm ready" }));
        const nextStep = screen.getByLabelText(/Setup step: 2 of 5/);
        expect(nextStep).toHaveFocus();
        fireEvent.keyDown(nextStep, { key: 'Escape' });
        expect(closeSetup).toHaveBeenCalledOnce();
    });
});
