/**
 * UX audit run 5 — the Log kebab's dialog chrome, honest lifetime tiles, and
 * the Plan page's Now button saying when it is already the choice.
 */
import React, { useCallback, useRef, useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { LogPageHeader } from '../pages/log/LogPageHeader';
import { VoyageStatsRollup, voyageStatsSubline } from '../pages/log/VoyageStatsRollup';
import { DepartControl } from '../components/passage/DepartControl';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { lifetimeVoyageStats } from '../utils/lifetimeVoyageStats';

vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

afterEach(cleanup);

/** LogPage's wiring for the kebab, reduced to what the header needs. */
const LogHeaderHarness: React.FC<{ hasLifetimeVoyages?: boolean; historyUnavailable?: boolean }> = ({
    hasLifetimeVoyages,
    historyUnavailable,
}) => {
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
            hasLifetimeVoyages={hasLifetimeVoyages}
            historyUnavailable={historyUnavailable}
            loggedEntries={[]}
        />
    );
};

describe('Log actions dialog', () => {
    it('matches the Route Planner actions chrome: title, Close, Escape, one reason for locked rows', () => {
        render(<LogHeaderHarness />);
        const trigger = screen.getByRole('button', { name: 'Log actions' });
        trigger.focus();
        fireEvent.click(trigger);

        const dialog = screen.getByRole('dialog', { name: 'Log actions' });
        const close = within(dialog).getByRole('button', { name: 'Close' });
        expect(close).toHaveFocus();
        // UX scorecard run 6: the reason sits under the title, before the rows,
        // and each waiting row is described by it.
        const reason = within(dialog).getByText('Record your first voyage to use these.');
        for (const label of ['Statistics', 'Track map', 'Export', 'Share']) {
            const row = within(dialog).getByRole('button', { name: label });
            expect(row).toBeDisabled();
            expect(row).toHaveAccessibleDescription('Record your first voyage to use these.');
            expect(reason.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        }
        expect(within(dialog).queryByRole('menuitem')).not.toBeInTheDocument();

        fireEvent.keyDown(close, { key: 'Escape' });
        expect(screen.queryByRole('dialog', { name: 'Log actions' })).not.toBeInTheDocument();
        expect(trigger).toHaveFocus();
    });

    it('names the waiting rows when only archived voyages exist (no trailing clocks; UX scorecard run 7)', () => {
        render(<LogHeaderHarness hasLifetimeVoyages />);
        fireEvent.click(screen.getByRole('button', { name: 'Log actions' }));
        const dialog = screen.getByRole('dialog', { name: 'Log actions' });
        const reason = 'Track map, Export and Share need a voyage in your current log.';
        expect(within(dialog).getByText(reason)).toBeVisible();
        const stats = within(dialog).getByRole('button', { name: 'Statistics' });
        expect(stats).toBeEnabled();
        expect(stats).not.toHaveAccessibleDescription(reason);
        for (const label of ['Track map', 'Export', 'Share']) {
            const row = within(dialog).getByRole('button', { name: label });
            expect(row).toBeDisabled();
            expect(row).toHaveAccessibleDescription(reason);
        }
    });
});

describe('Log actions when the account history did not load', () => {
    it('does not tell the skipper to record a first voyage (UX scorecard run 9)', () => {
        render(<LogHeaderHarness historyUnavailable />);
        // Named for the dialog it opens, like Plan's kebab.
        fireEvent.click(screen.getByRole('button', { name: 'Log actions' }));
        const dialog = screen.getByRole('dialog', { name: 'Log actions' });
        const reason = 'These need a voyage on this phone — your full history didn’t load.';
        expect(within(dialog).getByText(reason)).toBeVisible();
        expect(within(dialog).queryByText(/Record your first voyage/)).not.toBeInTheDocument();
        for (const label of ['Statistics', 'Track map', 'Export', 'Share']) {
            const row = within(dialog).getByRole('button', { name: label });
            expect(row).toBeDisabled();
            expect(row).toHaveAccessibleDescription(reason);
        }
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
        // The card says the short form, naming the cause (no page line is
        // above it here); its description says it in full.
        const card = screen.getByRole('button', { name: 'Voyage stats' });
        expect(within(card).getByText('Totals didn’t load')).toBeVisible();
        expect(card).toHaveAccessibleDescription('Totals from this phone only — full history didn’t load');
        expect(screen.queryByText(/Lifetime · includes archived/)).not.toBeInTheDocument();
        fireEvent.click(card);
        expect(screen.getAllByText('--')).toHaveLength(3);
        expect(screen.queryByText('0.0')).not.toBeInTheDocument();
        expect(screen.queryByText('0h 0m')).not.toBeInTheDocument();
        // Nothing local to count, so the notice does not call '--' "incomplete".
        expect(screen.getByRole('status')).toHaveTextContent('There are no voyages on this phone to count yet.');
        expect(screen.getByRole('status')).not.toHaveTextContent('incomplete');
    });

    it('keeps real local totals, tagged as this phone only', () => {
        render(
            <VoyageStatsRollup
                voyageStats={{ totalNm: 12.4, totalMs: 7_200_000, voyageCount: 1 }}
                records={records}
                lifetimeUnavailable
            />,
        );
        const card = screen.getByRole('button', { name: 'Voyage stats' });
        expect(within(card).getByText('Totals didn’t load')).toBeVisible();
        expect(card).toHaveAccessibleDescription('Totals from this phone only — full history didn’t load');
        fireEvent.click(card);
        expect(screen.getByText('12.4')).toBeVisible();
        expect(screen.queryByText('--')).not.toBeInTheDocument();
    });

    it('lets VoiceOver hear the warning and offers Retry that re-runs the load', () => {
        const retry = vi.fn();
        const stats = { totalNm: 12.4, totalMs: 7_200_000, voyageCount: 1 };
        /** LogPage's wiring: the reload clears the error while it runs. */
        const Harness: React.FC = () => {
            const [loading, setLoading] = useState(false);
            return (
                <>
                    <VoyageStatsRollup
                        voyageStats={stats}
                        records={records}
                        notice={loading ? 'Updating lifetime totals…' : undefined}
                        lifetimeUnavailable={!loading}
                        retrying={loading}
                        onRetry={() => {
                            retry();
                            setLoading(true);
                        }}
                    />
                    <button type="button" onClick={() => setLoading(false)}>
                        Fail again
                    </button>
                </>
            );
        };
        render(<Harness />);
        const toggle = screen.getByRole('button', { name: 'Voyage stats' });
        expect(toggle).toHaveAccessibleDescription('Totals from this phone only — full history didn’t load');
        // A button cannot hold a second button: the card's Retry is in its
        // sheet, beside the full notice (the shorthand gives way to it there).
        expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
        fireEvent.click(toggle);
        const sheet = screen.getByRole('dialog', { name: 'Voyage stats' });
        expect(within(sheet).queryByText('Totals from this phone only — full history didn’t load')).toBeNull();
        expect(within(sheet).getByRole('status')).toHaveTextContent(
            'These totals count only the voyages on this phone.',
        );
        fireEvent.click(within(sheet).getByRole('button', { name: 'Retry' }));
        expect(retry).toHaveBeenCalledOnce();

        // Mid-retry the card holds the warning instead of claiming "includes archived".
        expect(within(sheet).getByRole('button', { name: 'Retrying…' })).toBeDisabled();
        expect(toggle).toHaveAccessibleDescription('Totals from this phone only — full history didn’t load');
        expect(within(toggle).getByText('Totals didn’t load')).toBeVisible();
        expect(screen.queryByText(/Lifetime · includes archived/)).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Fail again' }));
        expect(within(sheet).getByRole('button', { name: 'Retry' })).toBeEnabled();
    });
});

describe('Voyage stats card face', () => {
    const records = lifetimeVoyageStats([], []).records;

    it('under the page’s history line keeps the short form, the cause said once above it', () => {
        render(
            <VoyageStatsRollup
                voyageStats={{ totalNm: 12.4, totalMs: 7_200_000, voyageCount: 1 }}
                records={records}
                lifetimeUnavailable
                underHistoryLine
            />,
        );
        const card = screen.getByRole('button', { name: 'Voyage stats' });
        expect(within(card).getByText('This phone only')).toBeVisible();
        expect(card).toHaveAccessibleDescription('Totals from this phone only — full history didn’t load');
    });

    it('says "Loading totals…" while the first lifetime read is out, never "No voyages yet"', () => {
        // Forty voyages in the cloud, none landed yet, one live entry counted.
        const { rerender } = render(
            <VoyageStatsRollup
                voyageStats={{ totalNm: 0, totalMs: 0, voyageCount: 0 }}
                records={records}
                retrying
                loaded={false}
            />,
        );
        const card = screen.getByRole('button', { name: 'Voyage stats' });
        expect(within(card).getByText('Loading totals…')).toBeVisible();
        expect(card).toHaveAccessibleDescription('Loading totals…');
        expect(screen.queryByText('No voyages yet')).not.toBeInTheDocument();
        rerender(
            <VoyageStatsRollup
                voyageStats={{ totalNm: 3.2, totalMs: 600_000, voyageCount: 1 }}
                records={records}
                retrying
                loaded={false}
            />,
        );
        expect(within(card).getByText('Loading totals…')).toBeVisible();
        expect(screen.queryByText(/1 voyage/)).not.toBeInTheDocument();
        // Landed: the real count. A later refresh keeps showing it.
        rerender(
            <VoyageStatsRollup
                voyageStats={{ totalNm: 1234.4, totalMs: 1, voyageCount: 40 }}
                records={records}
                retrying
                loaded
            />,
        );
        expect(within(card).getByText('40 voyages · 1,234 nm')).toBeVisible();
    });

    it('compacts five-figure miles on the card and keeps them exact for VoiceOver', () => {
        expect(voyageStatsSubline({ totalNm: 12_480, voyageCount: 128 })).toBe('128 voyages · 12.4k nm');
        expect(voyageStatsSubline({ totalNm: 12_480, voyageCount: 128 }, { exact: true })).toBe(
            '128 voyages · 12,480 nm',
        );
        expect(voyageStatsSubline({ totalNm: 9_999.4, voyageCount: 2 })).toBe('2 voyages · 9,999 nm');
        expect(voyageStatsSubline({ totalNm: 12.44, voyageCount: 1 })).toBe('1 voyage · 12.4 nm');
        render(<VoyageStatsRollup voyageStats={{ totalNm: 12_480, totalMs: 1, voyageCount: 128 }} records={records} />);
        const card = screen.getByRole('button', { name: 'Voyage stats' });
        expect(within(card).getByText('128 voyages · 12.4k nm')).toBeVisible();
        expect(card).toHaveAccessibleDescription('128 voyages · 12,480 nm · Lifetime · includes archived');
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
        // The card is a named group, and pressed Now is a neutral outline:
        // the LEAVING NOW chip carries the emerald (UX scorecard run 7).
        const group = screen.getByRole('group', { name: 'Departure' });
        expect(group).toContainElement(now);
        expect(group).toContainElement(screen.getByLabelText('Departure date'));
        expect(now.className).not.toContain('emerald');

        const later = new Date(Date.now() + 3 * 86_400_000);
        const pad = (value: number) => String(value).padStart(2, '0');
        const date = `${later.getFullYear()}-${pad(later.getMonth() + 1)}-${pad(later.getDate())}`;
        fireEvent.change(screen.getByLabelText('Departure date'), { target: { value: date } });
        expect(screen.getByRole('button', { name: 'Now' })).toHaveAttribute('aria-pressed', 'false');

        fireEvent.click(screen.getByRole('button', { name: 'Now' }));
        expect(screen.getByRole('button', { name: 'Now' })).toHaveAttribute('aria-pressed', 'true');
    });
});
