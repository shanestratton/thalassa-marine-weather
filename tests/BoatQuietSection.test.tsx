/**
 * Settings → Preferences → "If the boat goes quiet" (129-08): the skipper's
 * switch for the boat, and a crew member's own switch per boat they crew
 * with Share Instrument Panel. Hidden, every part of it, until its probe
 * answers: a build that ships before the migration never offers a switch
 * nothing honours. The skipper's switch writes the opt-in and the weekly
 * window (default Wed 19:30-19:50) in the boat's zone.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const svc = vi.hoisted(() => ({
    load: vi.fn(),
    save: vi.fn(),
    setCrew: vi.fn(),
    user: { id: '00000000-0000-4000-8000-000000000129' } as { id: string } | null,
}));

vi.mock('../services/boatQuiet/quietWatchService', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/boatQuiet/quietWatchService')>()),
    loadQuietWatch: svc.load,
    saveOwnerQuietWatch: svc.save,
    setCrewQuietPage: svc.setCrew,
}));
vi.mock('../stores/authStore', () => ({
    useAuthStore: (select: (s: { user: unknown }) => unknown) => select({ user: svc.user }),
}));
vi.mock('../context/WeatherContext', () => ({ useWeatherOptional: () => null }));

import { BoatQuietSection } from '../components/settings/BoatQuietSection';

const SKIPPER = '00000000-0000-4000-8000-000000000129';
const auckland = { dow: 3, start: '19:30', end: '19:50', tz: 'Pacific/Auckland' };

beforeEach(() => {
    vi.clearAllMocks();
    svc.user = { id: SKIPPER };
    localStorage.clear();
    svc.save.mockResolvedValue('saved');
    svc.setCrew.mockResolvedValue('saved');
});

describe('hidden until the probe answers', () => {
    it('nothing at all when the table and the crew call are not there', async () => {
        svc.load.mockResolvedValue({ owner: null, crew: [], crewPaging: false });
        const { container } = render(<BoatQuietSection satellite={false} />);
        await waitFor(() => expect(svc.load).toHaveBeenCalledWith(SKIPPER));
        await act(async () => undefined);
        expect(container).toBeEmptyDOMElement();
        expect(screen.queryByRole('switch')).toBeNull();
    });

    it('nothing, and no request, when signed out', async () => {
        svc.user = null;
        const { container } = render(<BoatQuietSection satellite={false} />);
        await act(async () => undefined);
        expect(container).toBeEmptyDOMElement();
        expect(svc.load).not.toHaveBeenCalled();
    });

    it('nothing while the probe is still out', () => {
        svc.load.mockReturnValue(new Promise(() => undefined));
        const { container } = render(<BoatQuietSection satellite={false} />);
        expect(container).toBeEmptyDOMElement();
    });
});

describe('the skipper’s switch', () => {
    it('on, with what it does, her window in her zone, and the internet caveat', async () => {
        svc.load.mockResolvedValue({
            owner: { enabled: true, graceMin: 15, window: auckland },
            crew: [],
            crewPaging: true,
        });
        render(<BoatQuietSection satellite={false} />);
        const toggle = await screen.findByRole('switch', { name: 'Page if the boat goes quiet' });
        expect(toggle).toHaveAttribute('aria-checked', 'true');
        expect(screen.getByRole('heading', { name: 'If the boat goes quiet' })).toBeInTheDocument();
        expect(screen.getByText(/Wed 19:30–19:50 Auckland time/)).toBeInTheDocument();
        expect(screen.getByText(/It hears her only while her Pi may use the internet\./)).toBeInTheDocument();
    });

    it('switching off writes the opt-in off and keeps her window', async () => {
        svc.load.mockResolvedValue({
            owner: { enabled: true, graceMin: 15, window: auckland },
            crew: [],
            crewPaging: true,
        });
        render(<BoatQuietSection satellite={false} />);
        fireEvent.click(await screen.findByRole('switch', { name: 'Page if the boat goes quiet' }));
        await waitFor(() => expect(svc.save).toHaveBeenCalledWith(SKIPPER, false, auckland));
        expect(screen.getByRole('switch', { name: 'Page if the boat goes quiet' })).toHaveAttribute(
            'aria-checked',
            'false',
        );
    });

    it('a first switch-on writes the default Wed 19:30–19:50 window in the ship’s zone', async () => {
        localStorage.setItem('thalassa_clock_zone', 'Europe/Paris');
        svc.load.mockResolvedValue({
            owner: { enabled: false, graceMin: 15, window: null },
            crew: [],
            crewPaging: true,
        });
        render(<BoatQuietSection satellite={false} />);
        const toggle = await screen.findByRole('switch', { name: 'Page if the boat goes quiet' });
        expect(toggle).toHaveAttribute('aria-checked', 'false');
        expect(screen.getByText(/Wed 19:30–19:50 Paris time/)).toBeInTheDocument();
        fireEvent.click(toggle);
        await waitFor(() =>
            expect(svc.save).toHaveBeenCalledWith(SKIPPER, true, {
                dow: 3,
                start: '19:30',
                end: '19:50',
                tz: 'Europe/Paris',
            }),
        );
    });

    it('a write that fails puts the switch back and says to check the connection', async () => {
        svc.save.mockResolvedValue('failed');
        svc.load.mockResolvedValue({
            owner: { enabled: true, graceMin: 15, window: auckland },
            crew: [],
            crewPaging: true,
        });
        render(<BoatQuietSection satellite={false} />);
        fireEvent.click(await screen.findByRole('switch', { name: 'Page if the boat goes quiet' }));
        expect(await screen.findByRole('status')).toHaveTextContent(
            'Couldn’t save that. Check your connection and try again.',
        );
        expect(screen.getByRole('switch', { name: 'Page if the boat goes quiet' })).toHaveAttribute(
            'aria-checked',
            'true',
        );
    });

    it('a write the server refuses says it was refused, not that the connection is at fault', async () => {
        svc.save.mockResolvedValue('refused');
        svc.load.mockResolvedValue({
            owner: { enabled: true, graceMin: 15, window: auckland },
            crew: [],
            crewPaging: true,
        });
        render(<BoatQuietSection satellite={false} />);
        fireEvent.click(await screen.findByRole('switch', { name: 'Page if the boat goes quiet' }));
        expect(await screen.findByRole('status')).toHaveTextContent(
            'Couldn’t save that: the server refused the change.',
        );
        expect(screen.getByRole('switch', { name: 'Page if the boat goes quiet' })).toHaveAttribute(
            'aria-checked',
            'true',
        );
    });

    it('while only 125’s watchdog answers, the line promises the skipper alone, no all-clear', async () => {
        svc.load.mockResolvedValue({
            owner: { enabled: true, graceMin: 15, window: auckland },
            crew: [],
            crewPaging: false,
        });
        render(<BoatQuietSection satellite={false} />);
        expect(await screen.findByText(/Thalassa pages you, once until she reports again\./)).toBeInTheDocument();
        expect(screen.queryByText(/crew|when she’s back/)).toBeNull();
    });

    it('satellite mode: says the watch cannot hear her and will page', async () => {
        svc.load.mockResolvedValue({
            owner: { enabled: true, graceMin: 15, window: auckland },
            crew: [],
            crewPaging: true,
        });
        render(<BoatQuietSection satellite />);
        expect(await screen.findByText(/Satellite mode keeps her Pi off the internet/)).toBeInTheDocument();
    });
});

describe('a crew member’s own switches', () => {
    const crew = [
        { ownerId: 'owner-avra', boatName: 'Αύρα', watchOn: true, pagingMe: true },
        { ownerId: 'owner-kestrel', boatName: 'Kestrel', watchOn: false, pagingMe: false },
        { ownerId: 'owner-unnamed', boatName: null, watchOn: true, pagingMe: true },
    ];

    it('one per boat, by her name, saying whether her skipper has the watch on', async () => {
        svc.load.mockResolvedValue({ owner: null, crew, crewPaging: true });
        render(<BoatQuietSection satellite={false} />);
        const avra = await screen.findByRole('switch', { name: 'Page me if Αύρα goes quiet' });
        expect(avra).toHaveAttribute('aria-checked', 'true');
        expect(screen.getByRole('switch', { name: 'Page me if Kestrel goes quiet' })).toHaveAttribute(
            'aria-checked',
            'false',
        );
        expect(screen.getByRole('switch', { name: 'Page me if the boat goes quiet' })).toBeInTheDocument();
        expect(screen.getAllByText(/Her skipper has the watch on: after 15 min/)).toHaveLength(2);
        expect(screen.getByText(/Her skipper hasn’t switched the watch on/)).toBeInTheDocument();
        expect(screen.queryByRole('switch', { name: 'Page if the boat goes quiet' })).toBeNull();
    });

    it('turning one off sets only that boat, for this account', async () => {
        svc.load.mockResolvedValue({ owner: null, crew, crewPaging: true });
        render(<BoatQuietSection satellite={false} />);
        fireEvent.click(await screen.findByRole('switch', { name: 'Page me if Αύρα goes quiet' }));
        await waitFor(() => expect(svc.setCrew).toHaveBeenCalledWith('owner-avra', false));
        expect(svc.setCrew).toHaveBeenCalledTimes(1);
        expect(screen.getByRole('switch', { name: 'Page me if Αύρα goes quiet' })).toHaveAttribute(
            'aria-checked',
            'false',
        );
        // Right under the switch now off, the line says so; never "you're paged".
        expect(
            screen.getByText('Her skipper has the watch on, but you’ve turned these pages off for yourself.'),
        ).toBeInTheDocument();
        expect(screen.getAllByText(/you’re paged/)).toHaveLength(1);
    });
});
