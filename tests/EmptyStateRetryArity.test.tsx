/**
 * "Try again" must actually try again.
 *
 * EmptyState used to pass its handlers straight to onClick, so the click's
 * MouseEvent became the handler's first argument. The Ship's Office loaders
 * (MaintenanceHub.loadTasks, InventoryList.loadItems) take an identity scope
 * as a defaulted first parameter — the event landed in that slot, the
 * identity guard rejected it, and the retry button was inert. Found by the
 * 2026-09-02 polish audit; fixed centrally in EmptyState.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EmptyState } from '../components/ui/EmptyState';
import { LoadErrorState } from '../components/ui/LoadErrorState';

describe('EmptyState handler arity', () => {
    it('calls onAction with no arguments', () => {
        const onAction = vi.fn();
        render(<EmptyState title="Nothing here" actionLabel="Do it" onAction={onAction} />);
        fireEvent.click(screen.getByRole('button', { name: 'Do it' }));
        expect(onAction).toHaveBeenCalledTimes(1);
        expect(onAction.mock.calls[0]).toHaveLength(0);
    });

    it('calls onSecondary with no arguments', () => {
        const onSecondary = vi.fn();
        render(
            <EmptyState
                title="Nothing here"
                actionLabel="Do it"
                onAction={() => {}}
                secondaryLabel="Later"
                onSecondary={onSecondary}
            />,
        );
        fireEvent.click(screen.getByRole('button', { name: 'Later' }));
        expect(onSecondary.mock.calls[0]).toHaveLength(0);
    });

    it('LoadErrorState retry reaches a defaulted-parameter loader intact', () => {
        // Mirrors MaintenanceHub.loadTasks(identity = getAuthIdentityScope()):
        // the default must survive the click.
        const seen: unknown[] = [];
        const loader = (identity: string = 'default-scope') => {
            seen.push(identity);
        };
        render(<LoadErrorState what="the maintenance log" onRetry={loader} />);
        fireEvent.click(screen.getByRole('button', { name: /try again/i }));
        expect(seen).toEqual(['default-scope']);
    });
});
