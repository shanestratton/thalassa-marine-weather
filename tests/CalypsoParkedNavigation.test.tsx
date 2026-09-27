/**
 * The parked Calypso page names the Radio and MOB pages, so it must also go
 * there — it was a dead end (UX scorecard run 6).
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { VIEW_REGISTRY, type ViewContext } from '../viewRegistry';
import { FEATURE_VISIBILITY } from '../utils/featureVisibility';

const ctx = (setPage: (view: string) => void): ViewContext => ({
    setPage,
    previousView: 'dashboard',
    setIsUpgradeOpen: vi.fn(),
    settings: {},
    updateSettings: vi.fn(),
    handleFavoriteSelect: vi.fn(),
    weatherAlerts: [],
});

describe.skipIf(FEATURE_VISIBILITY.calypsoConsole)('parked Calypso page', () => {
    it('opens the Radio and MOB pages it points to', () => {
        const setPage = vi.fn();
        const voice = VIEW_REGISTRY.voice;
        const Page = voice.component as React.ComponentType<Record<string, unknown>>;
        render(<Page {...(voice.getProps?.(ctx(setPage)) ?? {})} />);

        expect(screen.getByRole('heading', { name: 'Calypso is switched off' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Open Radio' }));
        expect(setPage).toHaveBeenLastCalledWith('radio');
        fireEvent.click(screen.getByRole('button', { name: 'Open MOB' }));
        expect(setPage).toHaveBeenLastCalledWith('mob');
    });
});

describe('pages whose Back returns to their opener say where that is (UX scorecard run 9)', () => {
    it.skipIf(FEATURE_VISIBILITY.calypsoConsole)('names the parked Calypso chevron and crumb after the opener', () => {
        const voice = VIEW_REGISTRY.voice;
        const Page = voice.component as React.ComponentType<Record<string, unknown>>;
        render(<Page {...(voice.getProps?.(ctx(vi.fn())) ?? {})} />);
        expect(screen.getByRole('button', { name: 'Back to The Glass' })).toBeInTheDocument();
        expect(screen.getByText('The Glass')).toBeInTheDocument();
    });

    it('hands MOB the name of the page it goes back to, and nothing it cannot name', () => {
        const props = (previousView: string) =>
            VIEW_REGISTRY.mob.getProps?.({ ...ctx(vi.fn()), previousView }) as Record<string, unknown>;
        expect(props('map')).toMatchObject({ backLabel: 'Back to Obs', breadcrumbs: ['Obs', 'Man Overboard'] });
        expect(props('vessel')).toMatchObject({ backLabel: 'Back to Vessel' });
        expect(props('inventory').backLabel).toBeUndefined();
    });
});
