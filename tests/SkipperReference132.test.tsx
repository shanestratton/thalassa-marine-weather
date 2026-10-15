/**
 * 132-B23: Skipper's Reference in the house shell, following the skipper's
 * hemisphere (binder audit SR-3 to SR-7).
 *
 * The page is PageHeader with the Boat Binder crumb (the 44 pt chevron, no
 * notch band of its own) inside the GPX import page's shell, its list the
 * scroller over the tab bar. Its synoptic and cyclone cards follow the
 * hemisphere of the GPS position, else the forecast's place, and say which;
 * before there is any position they show the south and say so, and the
 * skipper can pick the other one. The real LocationStore drives it; nothing
 * touches the network. Layout itself is measured in
 * browser-tests/menu-pages-fit.spec.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SkipperReference } from '../components/reference/SkipperReference';
import { LocationStore } from '../stores/LocationStore';
import { CHOSEN_HEMISPHERE_WORDS, hemisphereFromPlace } from '../services/reference/referenceHemisphere';

vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

const CARDS = [
    'GRIB in 60 Seconds',
    'Synoptic Chart Decoder',
    'Marine Forecast Decoder',
    'Squalls & Cyclone-Season Rules',
];

/** LocationStore's own placeholder: Brisbane, before any position is known. */
const placeholder = () =>
    LocationStore.setState({ lat: -27.47, lon: 153.02, name: 'Brisbane, QLD', source: 'initial' });

beforeEach(placeholder);
afterEach(placeholder);

const openCard = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
const hemisphereButton = (name: 'Southern' | 'Northern') =>
    within(screen.getByRole('group', { name: 'Your hemisphere' })).getByRole('button', { name });

describe('the hub, in the house shell', () => {
    it('has the Boat Binder crumb and a Back named for it', () => {
        const onBack = vi.fn();
        render(<SkipperReference onBack={onBack} />);
        expect(screen.getByRole('heading', { level: 1, name: "Skipper's Reference" })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Back to Boat Binder' }));
        expect(onBack).toHaveBeenCalledTimes(1);
    });

    it('lists the four cards by title, each subtitle read whole as its description', () => {
        render(<SkipperReference onBack={vi.fn()} />);
        const cards = screen.getAllByRole('button').filter((b) => b.classList.contains('skipper-ref-card'));
        expect(cards.map((b) => b.getAttribute('aria-label'))).toEqual(CARDS);
        expect(screen.getByRole('button', { name: 'Marine Forecast Decoder' })).toHaveAccessibleDescription(
            'Read the official coastal-waters forecast like the area average it actually is',
        );
    });

    it("is the GPX import page's shell: the page is the view's height and its list scrolls, clear of the tab bar", () => {
        const { container } = render(<SkipperReference onBack={vi.fn()} />);
        const page = container.firstElementChild as HTMLElement;
        expect(page).toHaveClass('h-full', 'overflow-hidden', 'flex-col');
        expect(page.className).not.toMatch(/min-h-screen/);
        const list = container.querySelector('.skipper-ref-scroll')!;
        expect(list).toHaveClass(
            'overflow-y-auto',
            'thalassa-scroll-fade',
            'thalassa-scroll-fade--nav',
            'skipper-ref-hub',
        );
        expect(list.querySelector('.skipper-ref-body .skipper-ref-cards')).not.toBeNull();
    });

    it('pads no notch band of its own, on the hub or a card', () => {
        // The app header already clears the status bar; the page's sticky header added it again.
        const source = readFileSync(join(process.cwd(), 'components/reference/SkipperReference.tsx'), 'utf8');
        expect(source).not.toMatch(/safe-area-inset-top/);
        expect(source).not.toMatch(/sticky top-0/);
        // The hub and a card's page are the fit stylesheet's: padded clear of the bar, 16 px over it.
        const css = readFileSync(join(process.cwd(), 'styles/menu-page-fit.css'), 'utf8');
        expect(css).toMatch(
            /\.skipper-ref-scroll > \.skipper-ref-body \{\s*padding-bottom: calc\(var\(--thalassa-tabbar-height\) \+ 16px\);/,
        );
        expect(css).toMatch(/\.skipper-ref-hub \{\s*container: skipper-ref \/ size;/);
        // Filling the screen never takes a card under the 44 pt target.
        expect(css).toMatch(/\.skipper-ref-card \{\s*flex: 1 0 auto;\s*min-height: 44px;/);
    });
});

describe('a card', () => {
    it('opens under a trail through the hub, and Back returns to the hub', () => {
        const onBack = vi.fn();
        render(<SkipperReference onBack={onBack} />);
        openCard('GRIB in 60 Seconds');
        expect(screen.getByRole('heading', { level: 1, name: 'GRIB in 60 Seconds' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: "Back to Skipper's Reference" }));
        expect(screen.getByRole('heading', { level: 1, name: "Skipper's Reference" })).toBeInTheDocument();
        expect(onBack).not.toHaveBeenCalled();
    });

    it('asks no hemisphere on a card that is the same in both', () => {
        render(<SkipperReference onBack={vi.fn()} />);
        openCard('GRIB in 60 Seconds');
        expect(screen.queryByRole('group', { name: 'Your hemisphere' })).toBeNull();
    });
});

describe('the hemisphere', () => {
    it('follows a northern GPS fix: northern rules, no Australian block, and says where it came from', () => {
        act(() => LocationStore.setFromGPS(41.49, -71.31));
        render(<SkipperReference onBack={vi.fn()} />);
        expect(screen.getByRole('button', { name: 'Synoptic Chart Decoder' })).toHaveAccessibleDescription(
            /Northern Hemisphere$/,
        );
        openCard('Synoptic Chart Decoder');
        expect(hemisphereButton('Northern')).toHaveAttribute('aria-pressed', 'true');
        expect(hemisphereButton('Southern')).toHaveAttribute('aria-pressed', 'false');
        expect(screen.getByText('Set from your GPS position.')).toBeInTheDocument();
        expect(screen.getByText('the low is on your LEFT hand')).toBeInTheDocument();
        expect(screen.queryByText('the low is on your RIGHT hand')).toBeNull();
        expect(screen.queryByRole('heading', { name: 'Australia & New Zealand' })).toBeNull();
    });

    it('follows a southern GPS fix, with the Australia & New Zealand detail in its labelled block', () => {
        act(() => LocationStore.setFromGPS(-27.2, 153.1));
        render(<SkipperReference onBack={vi.fn()} />);
        openCard('Synoptic Chart Decoder');
        expect(hemisphereButton('Southern')).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByText('the low is on your RIGHT hand')).toBeInTheDocument();
        const block = screen.getByRole('region', { name: 'Australia & New Zealand' });
        expect(
            within(block).getByRole('heading', { level: 3, name: 'FRONTS & THE SOUTHERLY CHANGE' }),
        ).toBeInTheDocument();
        expect(
            within(block).getByRole('heading', { level: 3, name: 'THE EAST COAST LOW — TRUST IT EARLY' }),
        ).toBeInTheDocument();
    });

    it("names the forecast's place when there is no GPS fix", () => {
        act(() => LocationStore.setFromFavorite(38.7, -9.14, 'Lisbon'));
        render(<SkipperReference onBack={vi.fn()} />);
        openCard('Squalls & Cyclone-Season Rules');
        expect(screen.getByText('Set from Lisbon.')).toBeInTheDocument();
        expect(screen.getByText(/officially 1 June to 30 November/)).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: 'WHAT A HURRICANE HOLE NEEDS' })).toBeInTheDocument();
    });

    it('shows the south before there is any position, says so, and keeps the skipper’s pick across cards', () => {
        render(<SkipperReference onBack={vi.fn()} />);
        openCard('Squalls & Cyclone-Season Rules');
        expect(hemisphereButton('Southern')).toHaveAttribute('aria-pressed', 'true');
        expect(
            screen.getByText('No position yet, so the Southern Hemisphere is shown. Pick yours.'),
        ).toBeInTheDocument();
        expect(screen.getByRole('region', { name: 'Australia & New Zealand' })).toBeInTheDocument();

        fireEvent.click(hemisphereButton('Northern'));
        expect(hemisphereButton('Northern')).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByText(CHOSEN_HEMISPHERE_WORDS)).toBeInTheDocument();
        expect(screen.getByText(/two peaks, around May and around November/)).toBeInTheDocument();
        expect(screen.queryByRole('region', { name: 'Australia & New Zealand' })).toBeNull();

        // Back at the hub and into the other card: still the north.
        fireEvent.click(screen.getByRole('button', { name: "Back to Skipper's Reference" }));
        expect(screen.getByRole('button', { name: 'Synoptic Chart Decoder' })).toHaveAccessibleDescription(
            /Northern Hemisphere$/,
        );
        openCard('Synoptic Chart Decoder');
        expect(hemisphereButton('Northern')).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByText(/ANTICLOCKWISE around a LOW/)).toBeInTheDocument();
    });

    it('gives each hemisphere button a 44 px target, in pixels, since the root font is fluid', () => {
        render(<SkipperReference onBack={vi.fn()} />);
        openCard('Synoptic Chart Decoder');
        for (const name of ['Southern', 'Northern'] as const) {
            const button = hemisphereButton(name);
            expect(button).toHaveClass('min-h-[44px]');
            // min-h-11 is 2.75rem: 41.25 px on an SE, whose root font is 4vw (15 px).
            expect(button.className).not.toMatch(/\bmin-h-11\b/);
        }
    });

    it('points the squall card at the Departure Window', () => {
        render(<SkipperReference onBack={vi.fn()} />);
        openCard('Squalls & Cyclone-Season Rules');
        expect(screen.getByRole('heading', { name: 'TIE IT TO THE DEPARTURE WINDOW' })).toBeInTheDocument();
        expect(screen.queryByText(/Go \/ No-Go/)).toBeNull();
    });
});

describe('hemisphereFromPlace', () => {
    it("takes the sign of the latitude from the GPS or a place, never from the store's placeholder", () => {
        expect(hemisphereFromPlace({ lat: -16.5, source: 'gps' })).toEqual({
            hemisphere: 'south',
            basis: 'gps',
            words: 'Set from your GPS position.',
        });
        expect(hemisphereFromPlace({ lat: 12.0, name: ' Grenada ', source: 'search' })).toEqual({
            hemisphere: 'north',
            basis: 'place',
            words: 'Set from Grenada.',
        });
        expect(hemisphereFromPlace({ lat: 25, name: '', source: 'map_pin' }).words).toBe(
            'Set from your forecast location.',
        );
        // Brisbane, before anything is known, is not the skipper's position.
        for (const place of [
            { lat: -27.47, name: 'Brisbane, QLD', source: 'initial' },
            { lat: 60, source: 'initial' },
            null,
        ]) {
            expect(hemisphereFromPlace(place)).toMatchObject({ hemisphere: 'south', basis: 'none' });
        }
        expect(hemisphereFromPlace({ lat: Number.NaN, source: 'gps' }).basis).toBe('none');
    });
});
