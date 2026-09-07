/**
 * The header glyph: a boat or a phone with a GPS dot, and no words on the
 * page (Shane 2026-09-08). The sentence lives only in the accessible name;
 * a held last fix makes the glyph a button that re-opens the boat-or-phone
 * question.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const world = vi.hoisted(() => ({
    weather: null as null | { positionSource: { kind: string } | null; positionChoice: { open: () => void } | null },
    link: { status: 'disconnected', remote: null } as { status: string; remote: { via: 'lan' | 'cloud' } | null },
    open: vi.fn(),
}));
vi.mock('../context/WeatherContext', () => ({ useWeatherOptional: () => world.weather }));
vi.mock('../components/nmea/useNmeaStore', () => ({ useNmeaConnectionStatus: () => world.link }));

import { GpsSourceGlyph, GpsSourceRow, resolveGpsSourceState } from '../components/GpsSourceGlyph';

describe('resolveGpsSourceState', () => {
    const at = (weatherKind: any, storeStatus: any = 'disconnected', remoteVia: any = null) =>
        resolveGpsSourceState({ weatherKind, storeStatus, remoteVia });

    it('a receiver on the boat is a live boat, whatever the weather chain is doing', () => {
        expect(at(null, 'connected')).toMatchObject({ glyph: 'boat', tone: 'live' });
        expect(at('phone', 'remote', 'lan')).toMatchObject({ glyph: 'boat', tone: 'live' });
        expect(at('bus')).toMatchObject({ glyph: 'boat', tone: 'live' });
        expect(at('pi')).toMatchObject({ glyph: 'boat', tone: 'live' });
    });

    it('the boat through the cloud is a boat with a sky dot', () => {
        expect(at('cloud')).toMatchObject({ glyph: 'boat', tone: 'cloud' });
        expect(at(null, 'remote', 'cloud')).toMatchObject({ glyph: 'boat', tone: 'cloud' });
    });

    it('her held last fix is a boat with an amber dot, and can be changed', () => {
        expect(at('held')).toMatchObject({ glyph: 'boat', tone: 'held', canChoose: true });
        expect(at('held').label).toContain('tap to choose');
    });

    it('the phone is a phone; nothing yet is neither', () => {
        expect(at('phone')).toMatchObject({ glyph: 'phone', tone: 'phone', canChoose: false });
        expect(at(null)).toMatchObject({ glyph: 'none', tone: 'none' });
    });
});

describe('<GpsSourceGlyph />', () => {
    it('renders a phone as an image with the sentence only in its accessible name', () => {
        world.weather = { positionSource: { kind: 'phone' }, positionChoice: { open: world.open } };
        world.link = { status: 'disconnected', remote: null };
        render(<GpsSourceGlyph />);
        const glyph = screen.getByTestId('gps-source-glyph');
        expect(glyph.getAttribute('data-glyph')).toBe('phone');
        expect(glyph.getAttribute('role')).toBe('img');
        expect(glyph.textContent).toBe('');
        expect(screen.getByRole('img', { name: /this phone’s GPS/ })).toBeInTheDocument();
    });

    it('a held fix is a button that re-opens the boat-or-phone question', () => {
        world.weather = { positionSource: { kind: 'held' }, positionChoice: { open: world.open } };
        world.link = { status: 'disconnected', remote: null };
        render(<GpsSourceGlyph />);
        const button = screen.getByRole('button', { name: /tap to choose the boat or this phone/ });
        expect(button.getAttribute('data-glyph')).toBe('boat');
        expect(button.getAttribute('data-tone')).toBe('held');
        fireEvent.click(button);
        expect(world.open).toHaveBeenCalledTimes(1);
    });

    it('works outside the weather provider, off the instrument store alone', () => {
        world.weather = null;
        world.link = { status: 'remote', remote: { via: 'lan' } };
        render(<GpsSourceGlyph />);
        expect(screen.getByTestId('gps-source-glyph').getAttribute('data-tone')).toBe('live');
    });
});

describe('<GpsSourceRow /> — the System Status panel row', () => {
    it('shows the glyph with the sentence beside it, minus the "Position:" prefix', () => {
        world.weather = { positionSource: { kind: 'cloud' }, positionChoice: null };
        world.link = { status: 'disconnected', remote: null };
        render(<GpsSourceRow />);
        const row = screen.getByTestId('gps-source-row');
        expect(row.getAttribute('data-glyph')).toBe('boat');
        expect(row.getAttribute('data-tone')).toBe('cloud');
        expect(screen.getByText('Position')).toBeInTheDocument();
        expect(screen.getByText('the boat’s GPS, through the cloud')).toBeInTheDocument();
    });
});
