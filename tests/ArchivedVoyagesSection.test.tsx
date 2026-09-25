import React, { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ArchivedVoyagesSection } from '../pages/log/ArchivedVoyagesSection';
import type { VoyageSummary } from '../services/shiplog/VoyageSummary';

vi.mock('../pages/log/useEndpointNames', () => ({
    useEndpointNames: (first: { latitude: number | null }) => ({
        startLabel: first.latitude === -27 ? 'Newport' : 'Butterfly Bay',
        endLabel: first.latitude === -27 ? 'Callemondah' : 'Daydream Island',
    }),
}));

const voyage = (id: string, group?: string): VoyageSummary => ({
    voyageId: id,
    passageGroupId: group,
    entryCount: 100,
    startedAt: '2026-09-15T00:00:00Z',
    departedAt: '2026-09-15T02:28:00Z',
    endedAt: '2026-09-17T00:44:00Z',
    totalDistanceNM: 306,
    avgSpeedKts: 6.8,
    hasManual: false,
    isPlannedRoute: false,
    isImported: false,
    firstLat: -27,
    firstLon: 153,
    lastLat: -23,
    lastLon: 151,
    firstIsOnWater: true,
    landFraction: 0,
    spanM: 400000,
});

function Archive({
    voyages = [],
    ...props
}: Partial<React.ComponentProps<typeof ArchivedVoyagesSection>> & { voyages?: readonly VoyageSummary[] }) {
    const [open, setOpen] = useState(true);
    return (
        <ArchivedVoyagesSection
            loggedArchivedVoyages={voyages}
            showArchived={open}
            setShowArchived={setOpen}
            handleUnarchiveVoyage={vi.fn().mockResolvedValue(undefined)}
            {...props}
        />
    );
}

describe('ArchivedVoyagesSection', () => {
    it('counts all five voyages, not the three visible passage/standalone groups', () => {
        render(
            <Archive
                voyages={[
                    voyage('third', 'north'),
                    voyage('daydream'),
                    voyage('second', 'north'),
                    voyage('first', 'north'),
                    voyage('butterfly'),
                ]}
            />,
        );
        expect(screen.getByText('5 voyages · 1 passage')).toBeVisible();
        expect(screen.getAllByRole('article')).toHaveLength(5);
        const passage = screen.getByRole('region', { name: 'Archived passage · 3 legs' });
        expect(within(passage).getAllByRole('article')).toHaveLength(3);
        expect(passage.className).toContain('border-purple');
        expect(within(passage).getByRole('heading', { name: 'PASSAGE' }).className).toContain('text-yellow');
    });

    it('shows named endpoints, distance, and duration from actual departure instead of arm time', () => {
        render(<Archive voyages={[voyage('trip')]} />);
        const card = screen.getByRole('article', { name: 'Newport → Callemondah' });
        expect(within(card).getByRole('heading', { name: 'Newport → Callemondah' })).toBeVisible();
        expect(within(card).getByText('15 Sept 26')).toBeVisible();
        expect(within(card).getByText('306.0 nm')).toBeVisible();
        expect(within(card).getByText('1d 22h')).toBeVisible();
        expect(within(card).queryByText('2d 0h')).not.toBeInTheDocument();
    });

    it('collapses cards while keeping the full voyage count visible', () => {
        render(<Archive voyages={[voyage('trip')]} />);
        const header = screen.getByRole('button', { name: 'Archived voyages 1 voyage Hide' });
        fireEvent.click(header);
        expect(header).toHaveAttribute('aria-expanded', 'false');
        expect(screen.queryByRole('article')).not.toBeInTheDocument();
        expect(screen.getByText('1 voyage')).toBeVisible();
        fireEvent.click(header);
        expect(screen.getAllByRole('article')).toHaveLength(1);
    });

    it('does not report an empty archive while loading or after a failed load', () => {
        const retry = vi.fn();
        const { rerender } = render(<Archive loading />);
        expect(screen.getByText('Loading archive…')).toBeVisible();
        expect(screen.queryByText('No archived voyages')).not.toBeInTheDocument();
        rerender(<Archive error="Archive could not be loaded." onRetry={retry} />);
        expect(screen.getByRole('alert')).toHaveTextContent('Archive could not be loaded.');
        expect(screen.getByText('Archive unavailable')).toBeVisible();
        expect(screen.queryByText('No archived voyages')).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Refresh archive' }));
        expect(retry).toHaveBeenCalledOnce();
        rerender(<Archive />);
        expect(screen.getByText('No archived voyages')).toBeVisible();
    });

    it('keeps current cards visible during refresh, with explicit updating feedback', () => {
        render(<Archive voyages={[voyage('trip')]} loading />);
        expect(screen.getByText('Updating archive…')).toBeVisible();
        expect(screen.getByText('1 voyage')).toBeVisible();
        expect(screen.getAllByRole('article')).toHaveLength(1);
    });

    it('restores only the chosen voyage, blocks duplicate taps, and waits for confirmed state', async () => {
        let resolve!: () => void;
        const restore = vi.fn(() => new Promise<void>((done) => (resolve = done)));
        render(<Archive voyages={[voyage('chosen'), voyage('other')]} handleUnarchiveVoyage={restore} />);
        const buttons = screen.getAllByRole('button', { name: /^Restore voyage Newport/ });
        fireEvent.click(buttons[0]);
        fireEvent.click(buttons[0]);
        expect(restore).toHaveBeenCalledExactlyOnceWith('chosen');
        expect(buttons[0]).toHaveAttribute('aria-busy', 'true');
        expect(buttons[1]).toBeDisabled();
        expect(screen.getByText('Restoring…')).toBeVisible();
        expect(screen.getAllByRole('article')).toHaveLength(2);
        await act(async () => resolve());
        expect(screen.getByRole('status')).toHaveTextContent('Voyage restored to your log.');
        expect(buttons[1]).toBeEnabled();
    });

    it('does not silently remove a voyage or announce success when restore fails', async () => {
        const retry = vi.fn();
        render(
            <Archive
                voyages={[voyage('trip')]}
                handleUnarchiveVoyage={vi.fn().mockRejectedValue(new Error('Restoring is unavailable while offline.'))}
                onRetry={retry}
            />,
        );
        fireEvent.click(screen.getByRole('button', { name: /^Restore voyage Newport/ }));
        await waitFor(() =>
            expect(screen.getByRole('alert')).toHaveTextContent('Restoring is unavailable while offline.'),
        );
        expect(screen.getByRole('status')).toBeEmptyDOMElement();
        expect(screen.getAllByRole('article')).toHaveLength(1);
        fireEvent.click(screen.getByRole('button', { name: 'Refresh archive' }));
        expect(retry).toHaveBeenCalledOnce();
    });

    it('confirms the exact archived members before restoring a passage, and supports cancel', async () => {
        const restore = vi.fn().mockResolvedValue(undefined);
        render(
            <Archive
                voyages={[voyage('leg2', 'north'), voyage('other'), voyage('leg1', 'north')]}
                handleRestorePassage={restore}
            />,
        );
        fireEvent.click(screen.getByRole('button', { name: 'Restore passage' }));
        expect(screen.getByRole('dialog')).toHaveTextContent('Return all 2 archived legs to your log.');
        expect(restore).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Restore passage' }));
        fireEvent.click(screen.getByRole('button', { name: 'Restore 2 legs' }));
        await waitFor(() => expect(restore).toHaveBeenCalledExactlyOnceWith('north', ['leg2', 'leg1']));
        expect(screen.getByRole('status')).toHaveTextContent('2 voyages restored to your log.');
    });

    it('keeps a confirmation bound to its original handler and member snapshot', async () => {
        const originalRestore = vi.fn().mockResolvedValue(undefined);
        const replacementRestore = vi.fn().mockResolvedValue(undefined);
        const { rerender } = render(
            <Archive voyages={[voyage('leg1', 'north')]} handleRestorePassage={originalRestore} />,
        );
        fireEvent.click(screen.getByRole('button', { name: 'Restore passage' }));
        rerender(
            <Archive
                voyages={[voyage('leg2', 'north'), voyage('leg1', 'north')]}
                handleRestorePassage={replacementRestore}
            />,
        );
        fireEvent.click(screen.getByRole('button', { name: 'Restore 1 leg' }));
        await waitFor(() => expect(originalRestore).toHaveBeenCalledExactlyOnceWith('north', ['leg1']));
        expect(replacementRestore).not.toHaveBeenCalled();
    });

    it('preserves the honest partial restore count supplied by the voyage service', async () => {
        render(
            <Archive
                voyages={[voyage('leg1', 'north'), voyage('leg2', 'north'), voyage('leg3', 'north')]}
                handleRestorePassage={vi
                    .fn()
                    .mockRejectedValue(new Error('Restored 1 of 3 voyages. Two remain archived.'))}
            />,
        );
        fireEvent.click(screen.getByRole('button', { name: 'Restore passage' }));
        fireEvent.click(screen.getByRole('button', { name: 'Restore 3 legs' }));
        await waitFor(() =>
            expect(screen.getByRole('alert')).toHaveTextContent('Restored 1 of 3 voyages. Two remain archived.'),
        );
        expect(screen.getByRole('status')).toBeEmptyDOMElement();
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
});
