import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TripPicker } from '../src/components/TripPicker';
import type { PublicVoyageTrip } from '../src/voyageLogApi';

/** Live shapes from the Serene Summer catalogue (2026-09-28), with the
 *  server's new optional fields as the from/to investigation tabled them. */
const NOW = Date.parse('2026-09-28T06:00:00Z');
const BRISBANE = 'Australia/Brisbane';
const track = (over: Partial<PublicVoyageTrip> & Pick<PublicVoyageTrip, 'id'>): PublicVoyageTrip => ({
    kind: 'track',
    label: 'Track · 1 Sept 2026',
    started_at: null,
    ended_at: null,
    active: false,
    point_count: 100,
    distance_nm: null,
    has_route: false,
    ...over,
});
// Every start below is a UTC evening: the old UTC-built labels put them a day early.
const HAMILTON = track({
    id: 'hamilton',
    label: 'Track · 25 Sept 2026',
    started_at: '2026-09-25T22:42:58.38+00:00',
    ended_at: '2026-09-26T01:16:23.42+00:00',
    distance_nm: 17.2,
    from_name: 'Hamilton Island',
    to_name: 'Airlie Beach',
    time_zone: BRISBANE,
});
const DAYDREAM_BOTH_NULL = track({
    id: 'daydream',
    label: 'Track · 24 Sept 2026',
    started_at: '2026-09-24T22:54:49.292+00:00',
    distance_nm: 10.8,
    from_name: null,
    to_name: null,
    time_zone: BRISBANE,
});
const BUTTERFLY_ROUTE = track({
    id: 'butterfly',
    label: 'Track · 23 Sept 2026',
    started_at: '2026-09-23T22:43:34.56+00:00',
    distance_nm: 15.6,
    has_route: true,
    from_name: 'Butterfly Bay',
    to_name: 'Daydream Island',
    time_zone: BRISBANE,
});
// An older server: none of the new keys at all.
const TONGUE_OLD_SERVER = track({
    id: 'tongue',
    label: 'Track · 22 Sept 2026',
    started_at: '2026-09-22T23:30:39.68+00:00',
    distance_nm: 17.9,
});
const NEWPORT_TO_ONLY = track({
    id: 'newport',
    label: 'Track · 15 Sept 2026',
    started_at: '2026-09-15T02:28:41.64+00:00',
    distance_nm: 306.4,
    to_name: 'Callemondah',
    time_zone: BRISBANE,
});
const MACKAY_FROM_ONLY = track({
    id: 'mackay',
    label: 'Track · 21 Sept 2026',
    started_at: '2026-09-21T05:57:21.91+00:00',
    distance_nm: 57.9,
    from_name: 'Mackay Harbour',
    to_name: null,
    time_zone: 'Mars/Olympus_Mons', // not a zone Intl knows: fall back, never throw
});
const ALL_DIARY: PublicVoyageTrip = {
    id: 'all-diary',
    kind: 'all-diary',
    label: 'All trips & diary',
    started_at: null,
    ended_at: null,
    active: false,
    point_count: 0,
    distance_nm: null,
    has_route: false,
};
// Deliberately out of order: the shelf sorts newest first itself.
const TRIPS = [
    NEWPORT_TO_ONLY,
    BUTTERFLY_ROUTE,
    HAMILTON,
    ALL_DIARY,
    TONGUE_OLD_SERVER,
    DAYDREAM_BOTH_NULL,
    MACKAY_FROM_ONLY,
];

/** Weekday + day + month in either locale order ('Sat 26 Sep' / 'Sat Sep 26'). */
const day = (weekday: string, date: number, month = 'Sept?') =>
    new RegExp(`${weekday} (${date} ${month}|${month} ${date})`);

function renderPicker(props: Partial<React.ComponentProps<typeof TripPicker>> = {}) {
    const onSelect = vi.fn();
    const utils = render(
        <TripPicker
            trips={TRIPS}
            latestTrip={HAMILTON}
            value="latest"
            onSelect={onSelect}
            loading={false}
            layout="hero"
            vesselName="Serene Summer"
            nowMs={NOW}
            fallbackTimeZone={BRISBANE}
            {...props}
        />,
    );
    return { onSelect, ...utils };
}

const chip = () => screen.getByRole('button', { name: /^Choose a voyage to view/ });
/** What a sighted reader sees: the text without the screen-reader-only ' to '. */
const seen = (element: HTMLElement): string => {
    const copy = element.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('.sr-only').forEach((node) => node.remove());
    return (copy.textContent ?? '').replace(/[ \t\n]+/g, ' ').trim();
};
const openDialog = () => {
    fireEvent.click(chip());
    return screen.getByRole('dialog', { name: 'Choose a voyage' });
};
const optionById = (dialog: HTMLElement, id: string) => {
    const option = within(dialog)
        .getAllByRole('option')
        .find((item) => item.getAttribute('data-trip-id') === id);
    if (!option) throw new Error(`no option ${id}`);
    return option;
};

afterEach(() => {
    cleanup();
    document.documentElement.style.overflow = '';
    document.body.style.overflow = '';
});

describe('public trip picker chip', () => {
    it('is a dialog button whose face leads with from → to and the boat-local date', () => {
        renderPicker();
        const button = chip();
        expect(button.tagName).toBe('BUTTON');
        expect(button).toHaveAttribute('aria-haspopup', 'dialog');
        expect(button).toHaveAttribute('aria-expanded', 'false');
        expect(button).toHaveAccessibleName(
            new RegExp(
                `^Choose a voyage to view · Latest trip · Hamilton Island to Airlie Beach · ${day('Sat', 26).source} · 17\\.2 nm$`,
            ),
        );
        expect(seen(button)).toMatch(/^Latest trip ?Hamilton Island → Airlie Beach ?/);
        expect(button.querySelector('.pv-arrow')).toHaveAttribute('aria-hidden', 'true');
        // 22:42 UTC on the 25th is Saturday morning at Hamilton Island.
        expect(seen(button)).toMatch(new RegExp(`${day('Sat', 26).source} · 17\\.2\\u00a0nm$`));
        expect(seen(button)).not.toMatch(/25 Sept 2026|Fri/);
    });

    it("falls back to today's date-and-distance face when neither end is named", () => {
        renderPicker({ value: 'daydream' });
        expect(chip()).toHaveAccessibleName(
            new RegExp(`^Choose a voyage to view · Trip · ${day('Fri', 25).source} · 10\\.8 nm$`),
        );
        expect(seen(chip())).toMatch(new RegExp(`^Trip ?${day('Fri', 25).source} · 10\\.8\\u00a0nm$`));
    });

    it('says the whole journey, and drops the eyebrow and meta line in the docked phone bar', () => {
        const { rerender, onSelect } = renderPicker({ value: 'all-diary', layout: 'bar' });
        expect(chip()).toHaveAccessibleName(/^Choose a voyage to view · Whole journey · All trips & diary$/);
        expect(chip()).not.toHaveTextContent('Whole journey');
        rerender(
            <TripPicker
                trips={TRIPS}
                latestTrip={HAMILTON}
                value="hamilton"
                onSelect={onSelect}
                loading={false}
                layout="bar"
                nowMs={NOW}
            />,
        );
        expect(seen(chip())).toBe('Hamilton Island → Airlie Beach');
    });

    it('is disabled and busy while a trip loads, without losing focus', () => {
        renderPicker({ loading: true });
        const button = chip();
        expect(button).toHaveAttribute('aria-disabled', 'true');
        expect(button).toHaveAttribute('aria-busy', 'true');
        // aria-busy on a button is not announced: the name says it.
        expect(button).toHaveAccessibleName(/ · loading$/);
        expect(button).not.toBeDisabled(); // stays focusable for the return trip
        fireEvent.click(button);
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('says no trip has started when there is none', () => {
        renderPicker({ trips: [ALL_DIARY], latestTrip: null });
        expect(chip()).toHaveAccessibleName('Choose a voyage to view · Latest trip · No trip started yet');
    });
});

describe('public trip picker dialog', () => {
    it('opens a labelled modal, focuses and marks the option showing, and locks the page', () => {
        renderPicker();
        const dialog = openDialog();
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        expect(chip()).toHaveAttribute('aria-expanded', 'true');
        expect(chip()).toHaveAttribute('aria-controls', dialog.id);
        expect(within(dialog).getByRole('heading', { level: 2, name: 'Choose a voyage' })).toBeInTheDocument();
        const listbox = within(dialog).getByRole('listbox', { name: 'Choose a voyage' });
        const latest = within(listbox).getByRole('option', { name: 'Latest trip', selected: true });
        expect(latest).toHaveFocus();
        expect(latest).toHaveAccessibleDescription(/Follows the boat into each new trip/);
        expect(within(dialog).getAllByRole('option', { selected: true })).toHaveLength(1);
        expect(within(dialog).getByRole('group', { name: 'Started trips' })).toBeInTheDocument();
        expect(within(dialog).getByRole('group', { name: 'Whole journey' })).toBeInTheDocument();
        expect(within(dialog).getByRole('option', { name: 'All trips & diary' })).toBeInTheDocument();
        expect(within(dialog).getByRole('button', { name: 'Close' })).toBeInTheDocument();
        expect(document.body.style.overflow).toBe('hidden');
        expect(document.documentElement.style.overflow).toBe('hidden');
    });

    it('lists started trips newest first, from → to in local dates, with honest fallbacks', () => {
        renderPicker();
        const dialog = openDialog();
        const started = within(within(dialog).getByRole('group', { name: 'Started trips' })).getAllByRole('option');
        expect(started.map((option) => option.getAttribute('data-trip-id'))).toEqual([
            'hamilton',
            'daydream',
            'butterfly',
            'tongue',
            'mackay',
            'newport',
        ]);
        const names = started.map(seen);
        expect(started[0]).toHaveAccessibleName(
            new RegExp(`^Hamilton Island to Airlie Beach ${day('Sat', 26).source}$`),
        );
        expect(names[0]).toMatch(/Hamilton Island → Airlie Beach/);
        expect(names[0]).toMatch(new RegExp(`${day('Sat', 26).source} · 17\\.2\u00a0nm`));
        expect(names[0]).toMatch(/Latest/);
        // Both ends null: the local date leads, not the UTC label.
        expect(started[1]).toHaveAccessibleName(day('Fri', 25));
        expect(names[1]).not.toMatch(/24 Sept|Track/);
        expect(names[2]).toMatch(/Butterfly Bay → Daydream Island/);
        expect(names[2]).toMatch(/Route/);
        // No new keys at all (an older server) reads exactly like null.
        expect(started[3]).toHaveAccessibleName(day('Wed', 23));
        // One named end reads 'From …', never 'Departed …': started_at is when
        // tracking began, which can be half a day before she left.
        expect(started[4]).toHaveAccessibleName(new RegExp(`^From Mackay Harbour ${day('Mon', 21).source}$`));
        expect(dialog.textContent).not.toMatch(/Departed/);
        expect(started[5]).toHaveAccessibleName(new RegExp(`^To Callemondah ${day('Tue', 15).source}$`));
        expect(names[5]).toMatch(/306\u00a0nm/);
        expect(dialog.textContent).not.toMatch(/Track ·/);
    });

    it('says each fact once to a screen reader, and says the latest trip is live or latest', () => {
        renderPicker();
        const dialog = openDialog();
        const hamilton = optionById(dialog, 'hamilton');
        // The date is in the name, so the description is the distance and tags only.
        expect(hamilton).toHaveAccessibleName(new RegExp(`^Hamilton Island to Airlie Beach ${day('Sat', 26).source}$`));
        expect(hamilton).toHaveAccessibleDescription(/^17\.2\snm Latest$/);
        expect(optionById(dialog, 'daydream')).toHaveAccessibleDescription(/^10\.8\snm$/);
        const latest = within(dialog).getByRole('option', { name: 'Latest trip' });
        expect(latest).toHaveAccessibleDescription(
            new RegExp(
                `^Latest Hamilton Island to Airlie Beach Follows the boat into each new trip ${day('Sat', 26).source} · 17\\.2\\snm$`,
            ),
        );
    });

    it('moves with the arrow keys, Home and End, and selects with Enter', () => {
        const { onSelect } = renderPicker();
        const dialog = openDialog();
        const latest = within(dialog).getByRole('option', { name: 'Latest trip' });
        fireEvent.keyDown(latest, { key: 'ArrowUp' });
        expect(latest).toHaveFocus();
        fireEvent.keyDown(latest, { key: 'ArrowDown' });
        const hamilton = optionById(dialog, 'hamilton');
        expect(hamilton).toHaveFocus();
        expect(hamilton).toHaveAttribute('tabindex', '0');
        expect(latest).toHaveAttribute('tabindex', '-1');
        fireEvent.keyDown(hamilton, { key: 'End' });
        expect(optionById(dialog, 'all-diary')).toHaveFocus();
        fireEvent.keyDown(optionById(dialog, 'all-diary'), { key: 'Home' });
        expect(latest).toHaveFocus();
        fireEvent.keyDown(latest, { key: 'ArrowDown' });
        fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
        expect(optionById(dialog, 'daydream')).toHaveFocus();
        fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
        expect(onSelect).toHaveBeenCalledOnce();
        expect(onSelect).toHaveBeenCalledWith('daydream');
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(chip()).toHaveFocus();
        expect(chip()).toHaveAttribute('aria-expanded', 'false');
        expect(document.body.style.overflow).toBe('');
    });

    it('selects with Space', () => {
        const { onSelect } = renderPicker({ value: 'hamilton' });
        const dialog = openDialog();
        expect(optionById(dialog, 'hamilton')).toHaveFocus();
        fireEvent.keyDown(optionById(dialog, 'hamilton'), { key: 'End' });
        fireEvent.keyDown(document.activeElement!, { key: ' ' });
        expect(onSelect).toHaveBeenCalledWith('all-diary');
    });

    it('traps Tab between the close button and the options', () => {
        renderPicker();
        const dialog = openDialog();
        const latest = within(dialog).getByRole('option', { name: 'Latest trip' });
        const close = within(dialog).getByRole('button', { name: 'Close' });
        expect(latest).toHaveFocus();
        fireEvent.keyDown(latest, { key: 'Tab' });
        expect(close).toHaveFocus();
        fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
        expect(latest).toHaveFocus();
    });

    it.each([
        ['Escape', () => fireEvent.keyDown(document.activeElement!, { key: 'Escape' })],
        [
            'Escape after a click on the dialog body',
            () => {
                // A click on the title or a gap focuses the dialog itself
                // (tabIndex -1), never <body>, so Escape still reaches the trap.
                const dialog = screen.getByRole('dialog');
                dialog.focus();
                fireEvent.keyDown(dialog, { key: 'Escape' });
            },
        ],
        ['the Close button', () => fireEvent.click(screen.getByRole('button', { name: 'Close' }))],
        [
            'the backdrop',
            () => {
                const scrim = screen.getByRole('dialog').parentElement!;
                fireEvent.pointerDown(scrim);
                fireEvent.click(scrim);
            },
        ],
    ])('closes on %s without choosing, and returns focus to the chip', (_how, close) => {
        const { onSelect } = renderPicker();
        openDialog();
        act(() => close());
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(onSelect).not.toHaveBeenCalled();
        expect(chip()).toHaveFocus();
        expect(document.body.style.overflow).toBe('');
    });

    it('is focusable only by click or script, never a Tab stop', () => {
        renderPicker();
        const dialog = openDialog();
        expect(dialog).toHaveAttribute('tabindex', '-1');
        expect(within(dialog).getByRole('option', { name: 'Latest trip' })).toHaveFocus();
    });

    it('stays open when a press on a card is dragged off and released over the backdrop', () => {
        const { onSelect } = renderPicker();
        const dialog = openDialog();
        const scrim = dialog.parentElement!;
        fireEvent.pointerDown(optionById(dialog, 'hamilton'));
        // The click lands on the nearest common ancestor: the backdrop.
        fireEvent.click(scrim);
        expect(screen.getByRole('dialog')).toBeInTheDocument();
        expect(onSelect).not.toHaveBeenCalled();
        // A click with no press on the backdrop (a synthetic one) does not close it either.
        fireEvent.click(scrim);
        expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('hands focus to the fallback when the choice folded the chip away', () => {
        const fallback = document.createElement('button');
        fallback.textContent = 'Restore page header';
        document.body.appendChild(fallback);
        try {
            const { onSelect } = renderPicker({ fallbackFocusRef: { current: fallback } });
            // A display:none chip ignores focus(); jsdom has no layout, so say so.
            chip().focus = () => {};
            const dialog = openDialog();
            fireEvent.click(within(dialog).getByRole('option', { name: 'All trips & diary' }));
            expect(onSelect).toHaveBeenCalledWith('all-diary');
            expect(fallback).toHaveFocus();
        } finally {
            fallback.remove();
        }
    });

    it('returns focus to the chip, not the fallback, whenever the chip can take it', () => {
        const fallback = document.createElement('button');
        document.body.appendChild(fallback);
        try {
            renderPicker({ fallbackFocusRef: { current: fallback } });
            openDialog();
            fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
            expect(chip()).toHaveFocus();
        } finally {
            fallback.remove();
        }
    });

    it('maps choices exactly like the old select: latest mode, a frozen id, the whole journey', () => {
        const { onSelect } = renderPicker({ value: 'butterfly' });
        let dialog = openDialog();
        expect(optionById(dialog, 'butterfly')).toHaveAttribute('aria-selected', 'true');
        expect(optionById(dialog, 'butterfly')).toHaveFocus();
        // A <select> fires no change for the option it already shows.
        fireEvent.click(optionById(dialog, 'butterfly'));
        expect(onSelect).not.toHaveBeenCalled();
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        dialog = openDialog();
        fireEvent.click(within(dialog).getByRole('option', { name: 'Latest trip' }));
        expect(onSelect).toHaveBeenLastCalledWith('latest');
        dialog = openDialog();
        fireEvent.click(within(dialog).getByRole('option', { name: 'All trips & diary' }));
        expect(onSelect).toHaveBeenLastCalledWith('all-diary');
        dialog = openDialog();
        fireEvent.click(optionById(dialog, 'newport'));
        expect(onSelect).toHaveBeenLastCalledWith('newport');
        expect(onSelect).toHaveBeenCalledTimes(3);
    });

    it('ignores a choice while a trip is still loading', () => {
        const { onSelect, rerender } = renderPicker();
        const dialog = openDialog();
        rerender(
            <TripPicker
                trips={TRIPS}
                latestTrip={HAMILTON}
                value="latest"
                onSelect={onSelect}
                loading
                layout="hero"
                nowMs={NOW}
            />,
        );
        expect(optionById(dialog, 'hamilton')).toHaveAttribute('aria-disabled', 'true');
        fireEvent.click(optionById(dialog, 'hamilton'));
        expect(onSelect).not.toHaveBeenCalled();
        expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('marks a live latest trip Live and says the Latest option follows the boat', () => {
        const live = { ...HAMILTON, active: true, ended_at: null };
        renderPicker({ trips: [live, ALL_DIARY], latestTrip: live });
        const dialog = openDialog();
        const latest = within(dialog).getByRole('option', { name: 'Latest trip' });
        expect(latest).toHaveTextContent(/Live/);
        expect(latest).toHaveTextContent(/Follows the boat into each new trip/);
        expect(latest).toHaveAccessibleDescription(/^Live Hamilton Island to Airlie Beach /);
        expect(optionById(dialog, 'hamilton')).toHaveTextContent(/Live/);
        expect(optionById(dialog, 'hamilton')).not.toHaveTextContent(/Latest/);
    });
});
