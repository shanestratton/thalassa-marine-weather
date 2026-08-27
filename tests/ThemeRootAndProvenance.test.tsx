/**
 * Two UI-honesty fixes from the 2026-08-27 audit.
 *
 * 1. THEME REACH. `.theme-onshore` styling is written as descendant rules and
 *    the CSS header says the class belongs "on the root element" — but the
 *    provider only put it on a div inside #root, while every overlay in the
 *    app portals to document.body. ~74 portaled surfaces therefore rendered
 *    with no onshore theming at all. `display-light` already syncs to the
 *    document element for exactly this reason.
 *
 * 2. FABRICATED BEARING. CurrentConditionsCard drew its wind arrow at
 *    `data.windDegree ? data.windDegree : 0`, so a missing bearing rendered
 *    an arrow pointing due south beside a "--" direction — the card inventing
 *    a heading. The truthy test also swallowed a real 0° (due north).
 */
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ThemeProvider } from '../context/ThemeContext';
import { useThemeStore } from '../stores/themeStore';
import { CurrentConditionsCard } from '../components/dashboard/CurrentConditionsCard';

afterEach(() => {
    document.documentElement.className = '';
});

const UNITS = { speed: 'kts', distance: 'nm', temp: 'C', length: 'm' } as never;
const baseData = {
    windSpeed: 12,
    windDirection: 'SE',
    precipitation: 10,
    uvIndex: 3,
    humidity: 60,
} as never;

describe('theme class reaches portaled overlays', () => {
    it('puts the environment theme on <html>, not just an inner div', () => {
        const environment = useThemeStore.getState().environment;
        render(
            <ThemeProvider>
                <span>child</span>
            </ThemeProvider>,
        );
        // Portals mount to document.body, so only a class at or above <html>
        // can reach them through a descendant selector.
        expect(document.documentElement.classList.contains(`theme-${environment}`)).toBe(true);
        expect(document.documentElement.getAttribute('data-theme')).toBe(environment);
    });

    it('cleans the class up on unmount so themes cannot stack', () => {
        const environment = useThemeStore.getState().environment;
        const { unmount } = render(
            <ThemeProvider>
                <span>child</span>
            </ThemeProvider>,
        );
        unmount();
        expect(document.documentElement.classList.contains(`theme-${environment}`)).toBe(false);
    });
});

describe('the wind arrow never invents a bearing', () => {
    it('draws no arrow when the bearing is missing', () => {
        render(<CurrentConditionsCard data={{ ...(baseData as object), windDegree: null } as never} units={UNITS} />);
        expect(screen.queryByRole('img', { name: /Wind from/ })).not.toBeInTheDocument();
    });

    it('draws the arrow for a real bearing, and says which way', () => {
        render(<CurrentConditionsCard data={{ ...(baseData as object), windDegree: 135 } as never} units={UNITS} />);
        expect(screen.getByRole('img', { name: 'Wind from 135 degrees' })).toBeInTheDocument();
    });

    it('treats due north (0°) as a real bearing, not as missing', () => {
        // The old `windDegree ? … : 0` could not tell 0° from absent.
        render(<CurrentConditionsCard data={{ ...(baseData as object), windDegree: 0 } as never} units={UNITS} />);
        expect(screen.getByRole('img', { name: 'Wind from 0 degrees' })).toBeInTheDocument();
    });
});
