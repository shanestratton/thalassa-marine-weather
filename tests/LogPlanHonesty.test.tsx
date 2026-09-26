/**
 * UX audit run 5 — the Log kebab's dialog chrome, honest lifetime tiles, and
 * the Plan page's Now button saying when it is already the choice.
 */
import React, { useCallback, useRef, useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { LogPageHeader } from '../pages/log/LogPageHeader';
import { VoyageStatsRollup } from '../pages/log/VoyageStatsRollup';
import { DepartControl } from '../components/passage/DepartControl';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { lifetimeVoyageStats } from '../utils/lifetimeVoyageStats';

vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

afterEach(cleanup);

/** LogPage's wiring for the kebab, reduced to what the header needs. */
const LogHeaderHarness: React.FC = () => {
    const [showMenu, setShowMenu] = useState(false);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const closeRef = useRef<HTMLButtonElement>(null);
    const close = useCallback(() => setShowMenu(false), []);
    const menuRef = useFocusTrap<HTMLDivElement>(showMenu, { initialFocusRef: closeRef, onEscape: close });
    return (
        <LogPageHeader
            isTracking={false}
            gpsStatus="none"
            hasRecordedFix={false}
            gpsHeadline=""
            overflowTriggerRef={triggerRef}
            overflowMenuRef={menuRef}
            overflowCloseRef={closeRef}
            overflowMenuId="log-actions"
            showMenu={showMenu}
            setShowMenu={setShowMenu}
            closeOverflowMenu={close}
            dispatch={vi.fn()}
            loggedVoyages={[]}
            loggedEntries={[]}
        />
    );
};

describe('Log actions dialog', () => {
    it('matches the Route Planner actions chrome: title, Close, Escape, one reason for locked rows', () => {
        render(<LogHeaderHarness />);
        const trigger = screen.getByRole('button', { name: 'Page actions' });
        trigger.focus();
        fireEvent.click(trigger);

        const dialog = screen.getByRole('dialog', { name: 'Log actions' });
        const close = within(dialog).getByRole('button', { name: 'Close' });
        expect(close).toHaveFocus();
        for (const label of ['Statistics', 'Track Map', 'Export', 'Share']) {
            expect(within(dialog).getByRole('button', { name: label })).toBeDisabled();
        }
        expect(within(dialog).getAllByText('Record a voyage to unlock these.')).toHaveLength(1);
        expect(within(dialog).queryByRole('menuitem')).not.toBeInTheDocument();

        fireEvent.keyDown(close, { key: 'Escape' });
        expect(screen.queryByRole('dialog', { name: 'Log actions' })).not.toBeInTheDocument();
        expect(trigger).toHaveFocus();
    });
});

describe('Voyage stats when lifetime history is unavailable', () => {
    const records = lifetimeVoyageStats([], []).records;

    it('shows -- and says "this phone only" instead of a hard 0.0 lifetime', () => {
        render(
            <VoyageStatsRollup
                voyageStats={{ totalNm: 0, totalMs: 0, voyageCount: 0 }}
                records={records}
                notice="Lifetime history is unavailable."
                lifetimeUnavailable
            />,
        );
        expect(screen.getByText('Lifetime unavailable · this phone only')).toBeVisible();
        expect(screen.queryByText('Lifetime · includes archived')).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Voyage stats' }));
        expect(screen.getAllByText('--')).toHaveLength(3);
        expect(screen.queryByText('0.0')).not.toBeInTheDocument();
        expect(screen.queryByText('0h 0m')).not.toBeInTheDocument();
    });

    it('keeps real local totals, tagged as this phone only', () => {
        render(
            <VoyageStatsRollup
                voyageStats={{ totalNm: 12.4, totalMs: 7_200_000, voyageCount: 1 }}
                records={records}
                lifetimeUnavailable
            />,
        );
        expect(screen.getByText('Lifetime unavailable · this phone only')).toBeVisible();
        fireEvent.click(screen.getByRole('button', { name: 'Voyage stats' }));
        expect(screen.getByText('12.4')).toBeVisible();
        expect(screen.queryByText('--')).not.toBeInTheDocument();
    });
});

describe('Departure Now button', () => {
    beforeEach(() => {
        sessionStorage.clear();
        setAuthIdentityScope(null);
        setAuthIdentityScope('account-a');
    });

    it('stays enabled but reads as pressed while departure is already now', () => {
        render(<DepartControl />);
        const now = screen.getByRole('button', { name: 'Now' });
        expect(now).toBeEnabled();
        expect(now).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByText('Departure')).toBeInTheDocument();

        const later = new Date(Date.now() + 3 * 86_400_000);
        const pad = (value: number) => String(value).padStart(2, '0');
        const date = `${later.getFullYear()}-${pad(later.getMonth() + 1)}-${pad(later.getDate())}`;
        fireEvent.change(screen.getByLabelText('Departure date'), { target: { value: date } });
        expect(screen.getByRole('button', { name: 'Now' })).toHaveAttribute('aria-pressed', 'false');

        fireEvent.click(screen.getByRole('button', { name: 'Now' }));
        expect(screen.getByRole('button', { name: 'Now' })).toHaveAttribute('aria-pressed', 'true');
    });
});
