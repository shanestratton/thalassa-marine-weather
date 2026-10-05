/**
 * The two ways into Sightings and its route:
 *   - Scuttlebutt's card (between Crew Chat and the channels), which only
 *     navigates, so ChatPage is untouched (Codex is working in it);
 *   - the Log page's big emerald Sighting pill on the live map, which opens
 *     the quick log over it and unmounts the map underneath (iOS paints
 *     Leaflet above fixed overlays), and at the top of the voyage list when
 *     this phone is not recording (crew, or a skipper who has not cast off);
 *   - the 'sightings' route: a Vessel child whose Back goes to Scuttlebutt.
 * Vessel names are fictional.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatChannel } from '../../services/ChatService';

vi.mock('../../services/PassagePlanService', () => ({ getActivePassageId: vi.fn(() => null) }));
vi.mock('../../components/LiveMiniMap', () => ({
    LiveMiniMap: ({ freeZoom }: { freeZoom?: boolean }) => (
        <div data-testid={freeZoom ? 'fullscreen-map' : 'mini-map'} />
    ),
}));
const sheet = vi.hoisted(() => ({ props: null as null | { openedAt: number; onClose: () => void } }));
vi.mock('../../components/sightings/QuickLogSheet', () => ({
    QuickLogSheet: (props: { openedAt: number; onClose: () => void }) => {
        sheet.props = props;
        return (
            <div role="dialog" aria-label="What did you see?">
                <button type="button" onClick={props.onClose}>
                    Close sheet
                </button>
            </div>
        );
    },
}));

const crewBox = vi.hoisted(() => ({ current: { vessel: null as unknown, vessels: [] as unknown[], version: 0 } }));
vi.mock('../../hooks/useCrewingVessel', () => ({ useCrewingVessel: () => crewBox.current }));

import { ChannelList } from '../../components/chat/ChannelList';
import { LogSightingEntry } from '../../components/sightings/LogSightingEntry';
import { setAuthIdentityScope } from '../../services/authIdentityScope';
import { useSettingsStore } from '../../stores/settingsStore';
import { SIGHTINGS_SEEN_KEY } from '../../components/sightings/SightingsEntryCard';
import { LogSightingPill } from '../../components/sightings/LogSightingPill';
import { LiveVoyageCard } from '../../pages/log/LiveVoyageCard';
import { useUIStore } from '../../stores/uiStore';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

const channelProps = () =>
    ({
        channels: [
            {
                id: 'general',
                name: 'General',
                description: 'Anything nautical',
                icon: '💬',
                is_private: false,
                is_global: true,
                status: 'active',
                created_at: '2026-10-01T00:00:00Z',
            } as unknown as ChatChannel,
        ],
        onOpenChannel: vi.fn(),
        onRequestAccess: vi.fn(),
        isMod: false,
        showProposalForm: false,
        setShowProposalForm: vi.fn(),
        proposalIcon: '',
        setProposalIcon: vi.fn(),
        proposalName: '',
        setProposalName: vi.fn(),
        proposalDesc: '',
        setProposalDesc: vi.fn(),
        proposalIsPrivate: false,
        setProposalIsPrivate: vi.fn(),
        proposalSent: false,
        onProposeChannel: vi.fn(),
        memberChannelIds: new Set<string>(),
        proposalParentId: null,
        setProposalParentId: vi.fn(),
    }) as React.ComponentProps<typeof ChannelList>;

function liveCardProps(): React.ComponentProps<typeof LiveVoyageCard> {
    return {
        liveStats: {
            activeEntries: [],
            first: undefined,
            dist: 12.4,
            durationHrs: 2,
            durationMins: 18,
            liveAvgSpeed: 5.4,
            departedAt: '2026-10-05T02:14:00Z',
        },
        engineGroupId: 'engine',
        engineRunning: false,
        toggleEngine: vi.fn(),
        liveMapExpanded: false,
        showTrackMap: false,
        followedRouteCoords: [],
        liveFix: null,
        currentFix: null,
        openLiveMap: vi.fn(),
        closeLiveMap: vi.fn(),
        expandLiveMapRef: React.createRef<HTMLButtonElement>() as React.RefObject<HTMLButtonElement>,
        shrinkLiveMapRef: React.createRef<HTMLButtonElement>() as React.RefObject<HTMLButtonElement>,
        liveMapDialogRef: React.createRef<HTMLDivElement>() as React.RefObject<HTMLDivElement>,
        liveMapTitleId: 'live-map-title',
    };
}

beforeEach(() => {
    localStorage.clear();
    sheet.props = null;
    useUIStore.setState({ currentView: 'chat', previousView: 'vessel' });
});
afterEach(() => cleanup());

describe('Scuttlebutt card', () => {
    it('sits above the channels and opens Sightings', () => {
        render(<ChannelList {...channelProps()} />);
        const card = screen.getByRole('button', { name: 'Sightings, new' });
        const channels = screen.getByRole('heading', { name: 'Channels' });
        expect(card.compareDocumentPosition(channels) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(card).toHaveAccessibleDescription('Whales, turtles, birds and fish your crew has seen');
        fireEvent.click(card);
        expect(useUIStore.getState().currentView).toBe('sightings');
        expect(useUIStore.getState().transitionDirection).toBe('push');
    });

    it('drops the New badge once Sightings has been opened on this phone', () => {
        localStorage.setItem(SIGHTINGS_SEEN_KEY, '1');
        render(<ChannelList {...channelProps()} />);
        const card = screen.getByRole('button', { name: 'Sightings' });
        expect(card).not.toHaveTextContent('NEW');
    });

    it('never opens the sightings store from the chat list (a static card, no counts)', () => {
        const src = read('components/sightings/SightingsEntryCard.tsx');
        expect(src).not.toMatch(/sightingStore|sightingService|sightingSync/);
        expect(read('components/chat/ChannelList.tsx')).toContain(
            '{FEATURE_VISIBILITY.sightings && <SightingsEntryCard />}',
        );
    });
});

describe('Log page Sighting pill', () => {
    it('is a 48 px emerald control on the live map that opens the quick log over it', async () => {
        render(<LiveVoyageCard {...liveCardProps()} />);
        const pill = screen.getByRole('button', { name: 'Log a sighting' });
        expect(pill).toHaveAttribute('aria-haspopup', 'dialog');
        expect(pill.className).toContain('h-[48px]');
        expect(pill.className).toContain('bg-emerald-700');
        expect(screen.getByTestId('mini-map')).toBeInTheDocument();
        const before = Date.now();
        await act(async () => {
            fireEvent.click(pill);
        });
        expect(await screen.findByRole('dialog', { name: 'What did you see?' })).toBeInTheDocument();
        // The tap is the sighting's time, not when the sheet's code arrived.
        expect(sheet.props!.openedAt).toBeGreaterThanOrEqual(before);
        expect(sheet.props!.openedAt).toBeLessThanOrEqual(Date.now());
        // Leaflet unmounts under the sheet, and comes back after.
        expect(screen.queryByTestId('mini-map')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Close sheet' }));
        expect(screen.getByTestId('mini-map')).toBeInTheDocument();
    });

    it('is also on the fullscreen live map, whose map unmounts under the sheet too', async () => {
        render(<LiveVoyageCard {...liveCardProps()} liveMapExpanded />);
        expect(screen.getByTestId('fullscreen-map')).toBeInTheDocument();
        const pills = screen.getAllByRole('button', { name: 'Log a sighting' });
        expect(pills).toHaveLength(2);
        await act(async () => {
            fireEvent.click(pills[1]);
        });
        await screen.findByRole('dialog', { name: 'What did you see?' });
        expect(screen.queryByTestId('fullscreen-map')).toBeNull();
    });

    it('reports the sheet opening and closing to its host', async () => {
        const onOpenChange = vi.fn();
        render(<LogSightingPill onOpenChange={onOpenChange} />);
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Log a sighting' }));
        });
        expect(onOpenChange).toHaveBeenLastCalledWith(true);
        fireEvent.click(await screen.findByRole('button', { name: 'Close sheet' }));
        expect(onOpenChange).toHaveBeenLastCalledWith(false);
    });

    it('is switched by the one feature flag, like the Scuttlebutt card', () => {
        expect(read('utils/featureVisibility.ts')).toMatch(/sightings: true,/);
        const card = read('pages/log/LiveVoyageCard.tsx');
        expect(card.match(/FEATURE_VISIBILITY\.sightings && \(/g)).toHaveLength(2);
        expect(card).toContain('!liveMapExpanded && !showTrackMap && !sightingOpen');
    });
});

describe('Log page, not recording', () => {
    const WREN = '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b';
    afterEach(() => {
        setAuthIdentityScope(null);
        crewBox.current = { vessel: null, vessels: [], version: 0 };
        useSettingsStore.setState({ activeVesselId: null } as never);
    });

    it('offers the pill to a skipper with a boat, and to crew with none of their own', () => {
        setAuthIdentityScope(WREN);
        useSettingsStore.setState({ activeVesselId: '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a' } as never);
        const { unmount } = render(<LogSightingEntry />);
        expect(screen.getByTestId('log-sighting-entry')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Log a sighting' })).toBeInTheDocument();
        unmount();
        useSettingsStore.setState({ activeVesselId: null } as never);
        crewBox.current = {
            vessel: { ownerId: 'f0e1d2c3-b4a5-4968-8776-655443322110', vesselName: 'Sea Pippin' },
            vessels: [],
            version: 1,
        };
        render(<LogSightingEntry />);
        expect(screen.getByRole('button', { name: 'Log a sighting' })).toBeInTheDocument();
    });

    it('stays away with no boat, or signed out', () => {
        setAuthIdentityScope(WREN);
        render(<LogSightingEntry />);
        expect(screen.queryByTestId('log-sighting-entry')).toBeNull();
        cleanup();
        setAuthIdentityScope(null);
        useSettingsStore.setState({ activeVesselId: '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a' } as never);
        render(<LogSightingEntry />);
        expect(screen.queryByTestId('log-sighting-entry')).toBeNull();
    });

    it("sits at the top of the voyage list, and the cards' mini maps unmount under the sheet", () => {
        const page = read('pages/LogPage.tsx');
        const list = page.slice(page.indexOf('<LogHistoryScroll>'));
        expect(list.indexOf('<LogSightingEntry onOpenChange={setSightingSheetOpen} />')).toBeGreaterThan(-1);
        expect(list.indexOf('<LogSightingEntry')).toBeLessThan(list.indexOf('<VoyageStatsRollup'));
        expect(page).toMatch(
            /\{FEATURE_VISIBILITY\.sightings && \(\s*<LogSightingEntry onOpenChange=\{setSightingSheetOpen\} \/>\s*\)\}/,
        );
        expect(page).toContain('suppressMiniMap={showTrackMap || liveMapExpanded || sightingSheetOpen}');
    });
});

describe('after a relaunch', () => {
    it('app start drains a waiting outbox, and loads nothing of Sightings otherwise', () => {
        const boot = read('hooks/useAppBootstrap.ts');
        expect(boot).toContain("import { sightingsOutboxFlagged } from '../services/sightings/outboxFlag';");
        expect(boot).toMatch(
            /if \(!sightingsOutboxFlagged\(activeUserId\)\) return;\s+import\('\.\.\/services\/sightings\/sightingSync'\)/,
        );
        expect(boot).toMatch(/ensureSightingSyncTriggers\(\);\s+scheduleSightingDrain\(3_000\);/);
        expect(boot).not.toMatch(/from '\.\.\/services\/sightings\/(sightingSync|sightingStore|sightingService)'/);
        // The hint is a few lines of localStorage and imports nothing.
        expect(read('services/sightings/outboxFlag.ts')).not.toMatch(/^import /m);
    });
});

describe('the route', () => {
    it('is a lazy Vessel child whose Back goes to Scuttlebutt and says so', () => {
        const registry = read('viewRegistry.tsx');
        expect(registry).toMatch(/import\('\.\/components\/sightings\/SightingsPage'\)/);
        const entry = registry.slice(registry.indexOf('    sightings: {'));
        expect(entry.slice(0, entry.indexOf('\n    },'))).toMatch(
            /group: 'vessel',[\s\S]*onBack: \(\) => ctx\.setPage\('chat'\),[\s\S]*\.\.\.backTo\('chat', 'Sightings'\)/,
        );
        expect(registry).toContain("sightings: 'Sightings',");
        expect(read('stores/uiStore.ts')).toMatch(/'chat',\n {4}'sightings',/);
    });

    it('keeps the Sightings page out of the main chunk (only the card and pill are static)', () => {
        for (const file of [
            'components/chat/ChannelList.tsx',
            'pages/log/LiveVoyageCard.tsx',
            'pages/LogPage.tsx',
            'components/sightings/LogSightingEntry.tsx',
            'viewRegistry.tsx',
        ]) {
            const src = read(file);
            expect(src, file).not.toMatch(/from '.*sightings\/(SightingsPage|QuickLogSheet|SightingsMap)'/);
            expect(src, file).not.toMatch(/from '.*services\/sightings\//);
        }
        expect(read('components/sightings/LogSightingPill.tsx')).toMatch(/import\('\.\/QuickLogSheet'\)/);
    });
});
