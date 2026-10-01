import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutoroutingProposalSaveCard } from '../components/autorouting/AutoroutingProposalSaveCard';
import type { AutoroutingTrialRoute } from '../types/autorouting';
import type { TrialRouteReview } from '../services/autoroutingReview';
import { autoroutingProposalGeometryKey } from '../services/autoroutingProposalEvidence';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';

const mock = vi.hoisted(() => ({ save: vi.fn(), registry: 'charts', listeners: new Set<() => void>() }));
vi.mock('../services/autoroutingProposalSave', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/autoroutingProposalSave')>()),
    saveReviewedAutoroutingProposal: (...args: unknown[]) => mock.save(...args),
}));
vi.mock('../services/enc/EncCellMetadata', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/enc/EncCellMetadata')>()),
    getRegistryFingerprint: () => mock.registry,
    subscribe: (listener: () => void) => {
        mock.listeners.add(listener);
        return () => mock.listeners.delete(listener);
    },
}));
const props = () => {
    const route: AutoroutingTrialRoute = {
        id: 'proposal',
        provider: 'Thalassa',
        createdAt: '2026-09-13T00:00:00Z',
        coordinates: [
            [153, -27],
            [153.1, -27.1],
        ],
        warnings: ['Inspect independently'],
        engine: {
            stateMask: ['green'],
            cellsUsed: ['OC-99-SYN001'],
            distanceNM: 7.8,
            elapsedMs: 10,
            backstop: 'verified',
        },
    };
    const review: TrialRouteReview = {
        phase: 'complete',
        basis: {
            proposalId: route.id,
            geometryKey: autoroutingProposalGeometryKey(route.coordinates),
            draftM: 1.5,
            draftAssumed: true,
            registryFingerprint: 'charts',
            vesselProfileKey: 'null',
            checkedAt: '2026-09-13T00:01:00Z',
        },
        legs: [
            {
                incomplete: true,
                verdict: {
                    grade: 'caution',
                    minDepthM: null,
                    minAt: null,
                    needsTide: false,
                    nudge: null,
                    nudgeTo: null,
                    issues: [],
                },
            },
        ],
    };
    return { route, review, draftM: 1.5, draftAssumed: true, onSaved: vi.fn(), onOpenSavedRoutes: vi.fn() };
};
const fill = () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save as planned route' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Planned route name' }), {
        target: { value: 'Weekend plan' },
    });
    fireEvent.click(screen.getByRole('checkbox'));
};
beforeEach(() => {
    localStorage.clear();
    setAuthIdentityScope('account-a');
    mock.registry = 'charts';
    mock.save.mockReset().mockReturnValue({ trace: { id: 'saved-1' }, cloud: Promise.resolve('schema-pending') });
});
afterEach(() => {
    act(() => setAuthIdentityScope(null));
});

describe('compact explicit proposal save control', () => {
    it('requires opening, a name and acknowledgement; saves once and does not open/activate routes automatically', async () => {
        const p = props();
        render(<AutoroutingProposalSaveCard {...p} />);
        expect(mock.save).not.toHaveBeenCalled();
        expect(screen.queryByRole('textbox')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Save as planned route' }));
        expect(screen.getByRole('button', { name: 'Save new planned route' })).toBeDisabled();
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Weekend plan' } });
        expect(screen.getByRole('button', { name: 'Save new planned route' })).toBeDisabled();
        fireEvent.click(screen.getByRole('checkbox'));
        fireEvent.click(screen.getByRole('button', { name: 'Save new planned route' }));
        expect(mock.save).toHaveBeenCalledTimes(1);
        expect(mock.save).toHaveBeenCalledWith(
            expect.objectContaining({
                name: 'Weekend plan',
                acknowledgedPlannedOnly: true,
                route: p.route,
                review: p.review,
            }),
            getAuthIdentityScope(),
        );
        expect(p.onSaved).toHaveBeenCalledWith({ id: 'saved-1' });
        expect(p.onOpenSavedRoutes).not.toHaveBeenCalled();
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('pending a server update'));
        expect(screen.getByRole('status')).toHaveTextContent('all detailed route points and evidence are retained');
        fireEvent.click(screen.getByRole('button', { name: 'Open Saved Routes' }));
        expect(p.onOpenSavedRoutes).toHaveBeenCalledTimes(1);
    });
    it('never writes on cancel', () => {
        render(<AutoroutingProposalSaveCard {...props()} />);
        fill();
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(mock.save).not.toHaveBeenCalled();
    });
    it.each(['checking', 'stopped', 'stale', 'error'] as const)('disables save for %s', (phase) => {
        const p = props();
        p.review.phase = phase;
        render(<AutoroutingProposalSaveCard {...p} />);
        expect(screen.getByRole('button', { name: 'Save as planned route' })).toBeDisabled();
    });
    it('invalidates open form immediately when the chart library changes', () => {
        render(<AutoroutingProposalSaveCard {...props()} />);
        fill();
        act(() => {
            mock.registry = 'new charts';
            for (const f of mock.listeners) f();
        });
        expect(screen.getByRole('button', { name: 'Save new planned route' })).toBeDisabled();
        expect(screen.getByText(/Charts changed/)).toBeInTheDocument();
        expect(screen.getByRole('checkbox')).not.toBeChecked();
        expect(screen.getByRole('textbox')).toHaveValue('Weekend plan');
        expect(mock.save).not.toHaveBeenCalled();
    });
    it.each(['checking', 'stale'] as const)(
        'requires fresh acknowledgement after %s and completion, retaining the name',
        (phase) => {
            const p = props();
            const { rerender } = render(<AutoroutingProposalSaveCard {...p} />);
            fill();
            p.review.phase = phase;
            rerender(<AutoroutingProposalSaveCard {...p} />);
            expect(screen.getByRole('checkbox')).not.toBeChecked();
            expect(screen.getByRole('checkbox')).toBeDisabled();
            expect(screen.getByRole('textbox')).toHaveValue('Weekend plan');
            p.review.phase = 'complete';
            p.review.basis!.checkedAt = '2026-09-13T00:02:00Z';
            rerender(<AutoroutingProposalSaveCard {...p} />);
            expect(screen.getByRole('checkbox')).not.toBeChecked();
            expect(screen.getByRole('button', { name: 'Save new planned route' })).toBeDisabled();
            fireEvent.click(screen.getByRole('checkbox'));
            expect(screen.getByRole('button', { name: 'Save new planned route' })).toBeEnabled();
            expect(mock.save).not.toHaveBeenCalled();
        },
    );
    it.each(['review completion', 'route note', 'added route note'] as const)(
        'requires fresh acknowledgement for same-object %s changes without clearing the name',
        (change) => {
            const p = props();
            const { rerender } = render(<AutoroutingProposalSaveCard {...p} />);
            fill();
            if (change === 'review completion') p.review.basis!.checkedAt = '2026-09-13T00:03:00Z';
            else if (change === 'route note') p.route.warnings[0] = 'A different warning needs review';
            else p.route.warnings.push('Bridges and power lines not checked on this chart.');
            rerender(<AutoroutingProposalSaveCard {...p} />);
            expect(screen.getByRole('checkbox')).not.toBeChecked();
            expect(screen.getByRole('textbox')).toHaveValue('Weekend plan');
            expect(screen.getByRole('button', { name: 'Save new planned route' })).toBeDisabled();
            expect(mock.save).not.toHaveBeenCalled();
        },
    );
    it('does not revive acknowledgement when a chart fingerprint reverts to the earlier reviewed value', () => {
        render(<AutoroutingProposalSaveCard {...props()} />);
        fill();
        act(() => {
            mock.registry = 'new charts';
            for (const listener of mock.listeners) listener();
        });
        act(() => {
            mock.registry = 'charts';
            for (const listener of mock.listeners) listener();
        });
        expect(screen.getByRole('checkbox')).not.toBeChecked();
        expect(screen.getByRole('textbox')).toHaveValue('Weekend plan');
        expect(screen.getByRole('button', { name: 'Save new planned route' })).toBeDisabled();
    });
    it('rechecks a same-object warning mutation at submission even before a parent render', () => {
        const p = props();
        render(<AutoroutingProposalSaveCard {...p} />);
        fill();
        p.route.warnings[0] = 'Warning changed before the click';
        fireEvent.click(screen.getByRole('button', { name: 'Save new planned route' }));
        expect(mock.save).not.toHaveBeenCalled();
        expect(screen.getByRole('alert')).toHaveTextContent('Review the current warnings');
        expect(screen.getByRole('textbox')).toHaveValue('Weekend plan');
    });
    it('resets name and acknowledgement for replacement coordinates', () => {
        const p = props();
        const { rerender } = render(<AutoroutingProposalSaveCard {...p} />);
        fill();
        p.route.coordinates[1][0] += 0.001;
        rerender(<AutoroutingProposalSaveCard {...p} />);
        expect(screen.queryByRole('textbox')).toBeNull();
        expect(screen.getByRole('button', { name: 'Save as planned route' })).toBeDisabled();
    });
    it('hides old-account form and late cloud result', async () => {
        let resolve!: (status: string) => void;
        mock.save.mockReturnValue({
            trace: { id: 'saved' },
            cloud: new Promise<string>((r) => {
                resolve = r;
            }),
        });
        render(<AutoroutingProposalSaveCard {...props()} />);
        fill();
        fireEvent.click(screen.getByRole('button', { name: 'Save new planned route' }));
        act(() => setAuthIdentityScope(null));
        await act(async () => resolve('ok'));
        expect(screen.queryByRole('status')).toBeNull();
        expect(screen.getByText(/Sign in before saving/)).toBeInTheDocument();
    });
    it('shows quota failure without success or an open-routes handoff', () => {
        mock.save.mockImplementation(() => {
            throw new Error('Device storage could not retain the complete proposal. Nothing was saved.');
        });
        const p = props();
        render(<AutoroutingProposalSaveCard {...p} />);
        fill();
        fireEvent.click(screen.getByRole('button', { name: 'Save new planned route' }));
        expect(screen.getByRole('alert')).toHaveTextContent('Nothing was saved');
        expect(screen.queryByRole('status')).toBeNull();
        expect(p.onSaved).not.toHaveBeenCalled();
        expect(screen.queryByRole('button', { name: 'Open Saved Routes' })).toBeNull();
    });
});
