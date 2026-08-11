import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Share } from '@capacitor/share';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FloatPlanSheet, type FloatPlanPreset } from '../components/vessel/FloatPlanSheet';

const mocks = vi.hoisted(() => ({
    vessel: {
        name: 'Serene Summer',
        type: 'sail' as const,
        model: 'Tayana 55',
        hullType: 'monohull' as const,
        length: 55,
        hullColor: 'white',
        registration: 'MQ258Q',
        mmsi: '501240101',
        callSign: 'VK4AFY',
        epirbHexId: '1D0E7A2B3C4D5E6',
        liferaftCapacity: 6,
        flaresExpiry: '2027-06-30',
        contactPhone: '+61 400 000 000',
    },
}));

vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: (selector: (state: { settings: { vessel: typeof mocks.vessel } }) => unknown) =>
        selector({ settings: { vessel: mocks.vessel } }),
}));

vi.mock('../services/routeTracer', () => ({ loadSavedTraces: () => [] }));

// RELATIVE, deliberately. This was `2026-08-10T00:00Z` — and on 2026-08-12
// five tests died at once with no relevant commit, because validateFloatPlan
// rightly demands the overdue time be in the FUTURE and the calendar had
// caught up with the fixture. A departure anchored to now() cannot expire.
const DEPARTURE = Date.now() + 6 * 3_600_000;
const PRESET: FloatPlanPreset = {
    route: {
        name: 'Capricorn passage',
        from: 'Newport',
        to: 'Lady Musgrave',
        distanceNM: 178,
        waypoints: [
            { lat: -27.14, lon: 153.09 },
            { lat: -23.9, lon: 152.4 },
        ],
    },
    departureMs: DEPARTURE,
    etaMs: DEPARTURE + 30 * 3_600_000,
    personsOnBoard: 3,
};

function enterRescueContact(): void {
    fireEvent.change(screen.getByLabelText(/Rescue contact and phone number/), {
        target: { value: 'Marine Rescue Bundaberg · 07 4159 4600' },
    });
}

describe('FloatPlanSheet', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.vessel.epirbHexId = '1D0E7A2B3C4D5E6';
    });

    it('switches between channel-accurate previews', () => {
        render(<FloatPlanSheet preset={PRESET} onClose={vi.fn()} />);

        const whatsapp = screen.getByRole('button', { name: /WhatsApp/ });
        expect(whatsapp).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByTestId('float-plan-preview')).toHaveTextContent('RAISE THE ALARM');

        fireEvent.click(screen.getByRole('button', { name: /Text Compact/ }));
        expect(screen.getByRole('button', { name: /Text Compact/ })).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByTestId('float-plan-preview')).toHaveTextContent('OVERDUE:');
        expect(screen.getByText(/SMS parts/)).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: /Email Full detail/ }));
        expect(screen.getByTestId('float-plan-preview')).toHaveTextContent(
            'Float plan | Serene Summer | Newport to Lady Musgrave',
        );
        expect(screen.getByTestId('float-plan-preview')).toHaveTextContent('PEOPLE & CONTACT');
    });

    it('shares the selected neutral format through the native share sheet', async () => {
        render(<FloatPlanSheet preset={PRESET} onClose={vi.fn()} />);
        enterRescueContact();
        fireEvent.click(screen.getByRole('button', { name: /More Any sharing app/ }));
        expect(screen.getByText(/Verify recipients and audience in the destination app/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Share formatted plan' }));

        await waitFor(() => expect(Share.share).toHaveBeenCalledOnce());
        expect(Share.share).toHaveBeenCalledWith(
            expect.objectContaining({
                title: expect.stringContaining('Serene Summer'),
                text: expect.stringContaining('IF YOU HAVE NOT HEARD FROM US'),
            }),
        );
    });

    it('blocks sharing when the people-aboard count reaches zero', () => {
        render(<FloatPlanSheet preset={PRESET} onClose={vi.fn()} />);
        const remove = screen.getByRole('button', { name: 'Remove one person aboard' });
        fireEvent.click(remove);
        fireEvent.click(remove);
        fireEvent.click(remove);

        expect(screen.getByRole('alert')).toHaveTextContent('Set the number of people aboard.');
        expect(screen.getByText('Open WhatsApp').closest('a')).toHaveAttribute('aria-disabled', 'true');
        expect(screen.getByRole('button', { name: 'Copy' })).toBeDisabled();
    });

    it('blocks an ambiguous rescue fallback while keeping equipment gaps as warnings', () => {
        mocks.vessel.epirbHexId = '';
        render(<FloatPlanSheet preset={PRESET} onClose={vi.fn()} />);

        expect(screen.getByRole('alert')).toHaveTextContent(
            'Add the jurisdiction-specific rescue contact and phone number',
        );
        expect(screen.getByRole('status', { name: 'Float plan safety warnings' })).toHaveTextContent(
            'No EPIRB hex ID is recorded',
        );
        expect(screen.getByRole('button', { name: 'Copy' })).toBeDisabled();

        fireEvent.change(screen.getByLabelText(/Rescue contact and phone number/), {
            target: { value: 'Marine Rescue Bundaberg' },
        });
        expect(screen.getByRole('button', { name: 'Copy' })).toBeDisabled();

        enterRescueContact();
        expect(screen.getByRole('button', { name: 'Copy' })).toBeEnabled();
    });

    it('copies exactly the selected formatted message', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText },
        });
        render(<FloatPlanSheet preset={PRESET} onClose={vi.fn()} />);
        enterRescueContact();

        fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
        await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
        expect(writeText.mock.calls[0][0]).toContain('🚨 *RAISE THE ALARM*');
        expect(screen.getByRole('button', { name: 'Copied ✓' })).toBeInTheDocument();
    });

    it('shows an aria-live manual fallback and retry when clipboard copy fails', async () => {
        const writeText = vi.fn().mockRejectedValueOnce(new Error('clipboard denied')).mockResolvedValue(undefined);
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText },
        });
        render(<FloatPlanSheet preset={PRESET} onClose={vi.fn()} />);
        enterRescueContact();

        fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
        const failure = await screen.findByTestId('float-plan-transfer-failure');
        expect(failure).toHaveAttribute('aria-live', 'assertive');
        expect(failure).toHaveTextContent('Copy failed');
        expect((screen.getByLabelText('Manual copy fallback') as HTMLTextAreaElement).value).toContain(
            'Marine Rescue Bundaberg',
        );

        fireEvent.click(screen.getByRole('button', { name: 'Retry copy' }));
        await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
        await waitFor(() => expect(screen.queryByTestId('float-plan-transfer-failure')).not.toBeInTheDocument());
        expect(screen.getByRole('button', { name: 'Copied ✓' })).toBeInTheDocument();
    });

    it('shows an aria-live manual fallback and retry when native sharing is not completed', async () => {
        vi.mocked(Share.share).mockRejectedValueOnce(new Error('share unavailable'));
        render(<FloatPlanSheet preset={PRESET} onClose={vi.fn()} />);
        enterRescueContact();
        fireEvent.click(screen.getByRole('button', { name: /More Any sharing app/ }));

        fireEvent.click(screen.getByRole('button', { name: 'Share formatted plan' }));
        const failure = await screen.findByTestId('float-plan-transfer-failure');
        expect(failure).toHaveAttribute('aria-live', 'assertive');
        expect(failure).toHaveTextContent('Sharing was not completed');
        expect((screen.getByLabelText('Manual copy fallback') as HTMLTextAreaElement).value).toContain(
            'Verify the recipients and audience in the destination app',
        );

        fireEvent.click(screen.getByRole('button', { name: 'Retry sharing' }));
        await waitFor(() => expect(Share.share).toHaveBeenCalledTimes(2));
        await waitFor(() => expect(screen.queryByTestId('float-plan-transfer-failure')).not.toBeInTheDocument());
        expect(screen.getByText(/Opened More · awaiting RECEIVED/)).toBeInTheDocument();
    });
});
