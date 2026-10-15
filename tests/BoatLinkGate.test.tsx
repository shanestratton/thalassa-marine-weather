/**
 * The boat link only when there is a boat (build 131, 131-01; was 126-10).
 *
 * A phone with no Pi paired and no gateway saved does not load the boat-link
 * service at start-up: the boot-path readers ask the gate, which loads it only
 * for a boat that has a link. A screen about the boat link loads it when it
 * opens, set up or not, and until it lands says "Checking…" — never "No
 * gateway", "Not connected" or a place. Fictional data only.
 */
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const link = vi.hoisted(() => ({
    pairing: null as null | { deviceId: string },
    saved: null as null | { host: string; port: number },
    pairingThrows: false,
    listeners: new Set<() => void>(),
    /** The service's snapshot: one object until something changes, as the real one keeps it. */
    snapshot: { pill: { text: 'Away · Live' } },
}));

vi.mock('../services/PiPairingService', () => ({
    getPairing: () => {
        if (link.pairingThrows) throw new Error('storage unavailable');
        return link.pairing;
    },
}));
vi.mock('../services/NmeaListenerService', () => ({
    NmeaListenerService: { getSavedConfig: () => link.saved },
}));
vi.mock('../services/boatLink/BoatLinkService', () => ({
    BoatLinkService: {
        subscribe: (listener: () => void) => {
            link.listeners.add(listener);
            return () => link.listeners.delete(listener);
        },
        getSnapshot: () => link.snapshot,
        evaluate: () => link.snapshot,
    },
}));

import {
    BOAT_LINK_CHECKING,
    boatLinkConfigured,
    boatLinkIfConfigured,
    loadBoatLink,
    loadedBoatLink,
    resetBoatLinkGateForTests,
    watchBoatLink,
} from '../services/boatLink/boatLinkGate';
import { useBoatLink } from '../hooks/useBoatLink';

/** A few macrotasks: long enough for a dynamic import that was started to land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
    resetBoatLinkGateForTests();
    link.pairing = null;
    link.saved = null;
    link.pairingThrows = false;
    link.listeners.clear();
    link.snapshot = { pill: { text: 'Away · Live' } };
});
afterEach(() => {
    cleanup();
});

describe('is there a boat link: a Pi paired or a gateway saved', () => {
    it('neither: no', () => {
        expect(boatLinkConfigured()).toBe(false);
    });

    it('a Pi paired, or a gateway saved: yes', () => {
        link.pairing = { deviceId: 'fixture-pi' };
        expect(boatLinkConfigured()).toBe(true);
        link.pairing = null;
        link.saved = { host: '192.0.2.151', port: 1457 };
        expect(boatLinkConfigured()).toBe(true);
    });

    it('a read that throws is no answer, not a crash', () => {
        link.pairingThrows = true;
        expect(boatLinkConfigured()).toBe(false);
    });
});

describe('the boot path loads it only for a boat that has a link', () => {
    it('a phone with no Pi and no gateway never loads it', async () => {
        expect(boatLinkIfConfigured()).toBeNull();
        await settle();
        expect(boatLinkIfConfigured()).toBeNull();
        expect(loadedBoatLink()).toBeNull();
    });

    it('a gateway saved: the first read starts the load and says "checking" (null) until it lands', async () => {
        link.saved = { host: '192.0.2.151', port: 1457 };
        expect(boatLinkIfConfigured()).toBeNull();
        await settle();
        const service = loadedBoatLink();
        expect(service).not.toBeNull();
        expect(boatLinkIfConfigured()).toBe(service);
    });

    it('a Pi paired: the same', async () => {
        link.pairing = { deviceId: 'fixture-pi' };
        boatLinkIfConfigured();
        await settle();
        expect(loadedBoatLink()).not.toBeNull();
    });

    it('loads once, however many ask', async () => {
        const [a, b] = await Promise.all([loadBoatLink(), loadBoatLink()]);
        expect(a).not.toBeNull();
        expect(a).toBe(b);
        expect(await loadBoatLink()).toBe(a);
    });
});

describe('a screen watching it', () => {
    it('is told once when it lands, then hears every change; stopping lets it go', async () => {
        const heard = vi.fn();
        const stop = watchBoatLink(heard);
        expect(heard).not.toHaveBeenCalled();
        await settle();
        expect(heard).toHaveBeenCalledTimes(1);
        expect(link.listeners.size).toBe(1);
        for (const listener of link.listeners) listener();
        expect(heard).toHaveBeenCalledTimes(2);
        stop();
        expect(link.listeners.size).toBe(0);
    });

    it('a watcher that stopped before it landed never subscribes', async () => {
        const heard = vi.fn();
        watchBoatLink(heard)();
        await settle();
        expect(heard).not.toHaveBeenCalled();
        expect(link.listeners.size).toBe(0);
    });

    it('useBoatLink: "Checking…" until it lands, then the service’s words — with no Pi and no gateway too', async () => {
        const Probe: React.FC = () => {
            const snapshot = useBoatLink();
            return <p>{(snapshot ?? BOAT_LINK_CHECKING).pill.text}</p>;
        };
        const { unmount } = render(<Probe />);
        expect(screen.getByText('Checking…')).toBeInTheDocument();
        expect(await screen.findByText('Away · Live')).toBeInTheDocument();
        expect(link.listeners.size).toBe(1);
        unmount();
        expect(link.listeners.size).toBe(0);
    });
});

describe('the words while it loads', () => {
    it('say "Checking…", in grey, and never claim no boat, no connection or a place', () => {
        const words = JSON.stringify(BOAT_LINK_CHECKING);
        for (const claim of ['No gateway', 'Not connected', 'Not set up', 'Aboard', 'Away', 'Live']) {
            expect(words).not.toContain(claim);
        }
        expect(BOAT_LINK_CHECKING.pill).toMatchObject({ text: 'Checking…', tone: 'grey', place: null });
        expect(BOAT_LINK_CHECKING.statusRow).toBe('Checking…');
        expect(BOAT_LINK_CHECKING.hub).toEqual({ value: 'Checking…', status: 'Instruments & AIS', tone: 'grey' });
        expect(BOAT_LINK_CHECKING.line).toBeNull();
        expect(BOAT_LINK_CHECKING.whereNote).toBeNull();
    });
});
