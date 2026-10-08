/**
 * What the skipper sees of the collision watch (125-01):
 *  - the alarm card names her and gives CPA, TCPA, bearing, range and the
 *    report's age; DANGER offers a 30-minute mute, close quarters only an
 *    acknowledgement (never a mute);
 *  - the honest notices ('blind', 'paused', 'was paused');
 *  - arming the shield opens the real sound check first, worded for the
 *    collision watch, while the anchor's own sound check is unchanged;
 *  - the inshore/offshore thresholds live in Settings → Preferences.
 *
 * Fictional MMSIs and vessel names only.
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
    guard: { enabled: false, radiusNm: 2, alerts: [] as unknown[] },
    setEnabled: vi.fn(),
    armAfterSoundCheck: vi.fn(),
    setRadius: vi.fn(),
}));

vi.mock('../services/AisGuardZone', () => ({
    AisGuardZone: {
        getState: () => hoisted.guard,
        subscribe: () => () => undefined,
        setEnabled: hoisted.setEnabled,
        armAfterSoundCheck: hoisted.armAfterSoundCheck,
        setRadius: hoisted.setRadius,
    },
}));
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

import { AisGuardAlert } from '../components/map/AisGuardAlert';
import { AisLegend } from '../components/map/AisLegend';
import { SoundCheckModal } from '../components/anchor-watch/SoundCheckModal';
import {
    AisGuardAlertStore,
    COLLISION_AT_ANCHOR_NOTICE,
    COLLISION_BLIND_NOTICE,
    COLLISION_NO_MOTION_NOTICE,
    COLLISION_PAUSED_NOTICE,
    COLLISION_STOPPED_NOTICE,
    COLLISION_UNCHECKED_NOTICE,
    type CollisionAlertCard,
} from '../services/aisGuardAlertStore';
import { AlarmAudioService } from '../services/AlarmAudioService';

const T0 = Date.UTC(2026, 9, 9, 6, 0, 0);

function card(mmsi: number, name: string, extra: Partial<CollisionAlertCard['collision']> = {}): CollisionAlertCard {
    return {
        mmsi,
        name,
        distanceNm: 1.4,
        bearing: 44,
        sog: 11.5,
        cog: 230,
        shipType: '70',
        timestamp: T0,
        collision: {
            cpaNm: 0.2,
            tcpaMin: 7.5,
            closeQuarters: false,
            reportAgeSec: 12,
            source: 'local',
            ...extra,
        },
    };
}

beforeEach(() => {
    AisGuardAlertStore.clear();
    hoisted.guard = { enabled: false, radiusNm: 2, alerts: [] };
    hoisted.setEnabled.mockClear();
    hoisted.armAfterSoundCheck.mockClear();
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

describe('the collision alarm card', () => {
    it('names her and gives CPA, TCPA, bearing, range and age; DANGER can be muted for 30 minutes', () => {
        act(() => AisGuardAlertStore.setCollision([card(123400201, 'FICTIONAL TRADER')], T0));
        render(<AisGuardAlert />);
        const alarm = screen.getByRole('alert');
        expect(alarm).toHaveTextContent('COLLISION RISK');
        expect(alarm).toHaveTextContent('FICTIONAL TRADER');
        expect(alarm).toHaveTextContent('CPA 0.20 NM in 8 min');
        expect(alarm).toHaveTextContent('044° · 1.4 NM');
        expect(alarm).toHaveTextContent('AIS 12 s old');

        const mute = within(alarm).getByRole('button', { name: 'Mute FICTIONAL TRADER for 30 minutes' });
        fireEvent.click(mute);
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('close quarters offers only an acknowledgement, never a mute', () => {
        act(() =>
            AisGuardAlertStore.setCollision(
                [card(123400202, 'FICTIONAL FERRY', { closeQuarters: true, cpaNm: 0.04, tcpaMin: 2.1 })],
                T0,
            ),
        );
        render(<AisGuardAlert />);
        const alarm = screen.getByRole('alert');
        expect(alarm).toHaveTextContent('CLOSE QUARTERS');
        expect(within(alarm).queryByRole('button', { name: /Mute/ })).toBeNull();
        expect(
            within(alarm).getByRole('button', { name: 'Acknowledge close quarters with FICTIONAL FERRY' }),
        ).toBeInTheDocument();
    });

    it('says when a target came over the internet, and how old it is', () => {
        act(() =>
            AisGuardAlertStore.setCollision(
                [card(123400203, 'FICTIONAL TUG', { source: 'cloud', reportAgeSec: 180 })],
                T0,
            ),
        );
        render(<AisGuardAlert />);
        expect(screen.getByRole('alert')).toHaveTextContent('internet AIS, 3 min old');
    });

    it('a guard-ring card with an unknown speed shows a dash, not 0.0 kts', () => {
        act(() => {
            window.dispatchEvent(
                new CustomEvent('ais-guard-alert', {
                    detail: [
                        {
                            mmsi: 123400204,
                            name: 'FICTIONAL DRIFTER',
                            distanceNm: 1.1,
                            bearing: 10,
                            sog: null,
                            cog: null,
                            shipType: '0',
                            timestamp: T0,
                        },
                    ],
                }),
            );
        });
        render(<AisGuardAlert />);
        const alarm = screen.getByRole('alert');
        expect(alarm).toHaveTextContent('GUARD ZONE ALERT');
        expect(alarm).toHaveTextContent('— kts');
        expect(alarm).not.toHaveTextContent('0.0 kts');
    });
});

describe('a lost contact', () => {
    it('reads CPA UNKNOWN with the reason and the last CPA, never passed, and keeps its mute button', () => {
        act(() =>
            AisGuardAlertStore.setCollision(
                [
                    card(123400205, 'FICTIONAL COASTER', {
                        lost: { reason: 'no-fix', sinceMs: T0, lastCpaAt: T0 - 120_000 },
                    }),
                ],
                T0,
            ),
        );
        vi.spyOn(Date, 'now').mockReturnValue(T0);
        render(<AisGuardAlert />);
        const alarm = screen.getByRole('alert');
        expect(alarm).toHaveTextContent('COLLISION RISK: CPA UNKNOWN');
        expect(alarm).toHaveTextContent('CPA unknown: no position fix');
        expect(alarm).toHaveTextContent('last CPA 0.20 NM in 8 min, 2 min ago');
        expect(alarm).not.toHaveTextContent(/PASSED/);
        expect(
            within(alarm).getByRole('button', { name: 'Mute FICTIONAL COASTER for 30 minutes' }),
        ).toBeInTheDocument();
    });

    it('a contact given up on reads NOT SHOWN CLEAR, and only then offers Dismiss', () => {
        act(() => AisGuardAlertStore.setCollision([card(123400206, 'FICTIONAL LINER')], T0));
        act(() =>
            AisGuardAlertStore.setCollision(
                [],
                T0 + 60_000,
                new Map([[123400206, { how: 'lost', lost: { reason: 'gone', sinceMs: T0, lastCpaAt: T0 } }]]),
            ),
        );
        render(<AisGuardAlert />);
        const alarm = screen.getByRole('alert');
        expect(alarm).toHaveTextContent('CONTACT LOST: NOT SHOWN CLEAR');
        expect(
            within(alarm).getByRole('button', { name: 'Dismiss collision alert for FICTIONAL LINER' }),
        ).toBeInTheDocument();
    });

    it('a vessel that merely drops off the list is never relabelled', () => {
        act(() => AisGuardAlertStore.setCollision([card(123400207, 'FICTIONAL BARGE')], T0));
        act(() => AisGuardAlertStore.setCollision([], T0 + 5_000));
        render(<AisGuardAlert />);
        expect(screen.getByRole('alert')).toHaveTextContent('COLLISION RISK');
        expect(screen.getByRole('alert')).not.toHaveTextContent('PASSED');
    });
});

describe('the honest notices', () => {
    it('stopped, own motion unknown and the pre-125 shield say so in plain words', () => {
        render(<AisGuardAlert />);
        act(() => AisGuardAlertStore.setWatchNotice({ state: 'stopped', since: T0 }));
        expect(screen.getByRole('status')).toHaveTextContent(COLLISION_STOPPED_NOTICE);
        act(() => AisGuardAlertStore.setWatchNotice({ state: 'no-motion', since: T0 }));
        expect(screen.getByRole('status')).toHaveTextContent(COLLISION_NO_MOTION_NOTICE);
        act(() => AisGuardAlertStore.setWatchNotice({ state: 'unchecked', since: T0 }));
        expect(screen.getByRole('status')).toHaveTextContent(COLLISION_UNCHECKED_NOTICE);
    });

    it('stopped at a berth and stopped at anchor say which, and what each means (125-01b)', () => {
        render(<AisGuardAlert />);
        act(() => AisGuardAlertStore.setWatchNotice({ state: 'stopped', since: T0 }));
        expect(screen.getByRole('status')).toHaveTextContent(
            'Collision watch: stopped with no anchor watch, so it stays quiet until you make 0.5 kn',
        );
        act(() => AisGuardAlertStore.setWatchNotice({ state: 'at-anchor', since: T0 }));
        expect(screen.getByRole('status')).toHaveTextContent(COLLISION_AT_ANCHOR_NOTICE);
        expect(screen.getByRole('status')).toHaveTextContent(
            'Collision watch at anchor: it still sounds for a vessel under way coming within 0.1 NM',
        );
        // A number keeps its unit on its line at 320 pt ('0.1 / NM' read badly in WebKit).
        expect(screen.getByRole('status').textContent).toContain('0.1\u00a0NM');
        // A status line, not a dismissible notice.
        expect(screen.queryByRole('button', { name: 'Dismiss collision watch notice' })).toBeNull();
    });

    it('at anchor, blind on its own 10 min line; stopped with the watch kept elsewhere says so (125-01b review)', () => {
        render(<AisGuardAlert />);
        act(() => AisGuardAlertStore.setWatchNotice({ state: 'blind-at-anchor', since: T0 }));
        expect(screen.getByRole('status')).toHaveTextContent('Collision watch blind: no AIS for 10 min');
        expect(screen.getByRole('status').textContent).toContain('10\u00a0min');
        act(() => AisGuardAlertStore.setWatchNotice({ state: 'stopped-elsewhere', since: T0 }));
        expect(screen.getByRole('status')).toHaveTextContent(
            'Collision watch: stopped, and the anchor watch is kept elsewhere, so it stays quiet until you make 0.5 kn',
        );
        // Never 'no anchor watch' while one is on.
        expect(screen.getByRole('status').textContent).not.toMatch(/no anchor watch/);
        expect(screen.queryByRole('button', { name: 'Dismiss collision watch notice' })).toBeNull();
    });

    it('a pause of seconds is said in seconds, never rounded up to a minute', () => {
        render(<AisGuardAlert />);
        act(() =>
            AisGuardAlertStore.setWatchNotice({ state: 'resumed', since: T0, pausedFrom: T0, resumedAt: T0 + 4_000 }),
        );
        expect(screen.getByRole('status')).toHaveTextContent('Collision watch was paused for 4 s while');
    });

    it('blind and paused are said in plain words', () => {
        render(<AisGuardAlert />);
        act(() => AisGuardAlertStore.setWatchNotice({ state: 'blind', since: T0 }));
        expect(screen.getByRole('status')).toHaveTextContent(COLLISION_BLIND_NOTICE);
        act(() => AisGuardAlertStore.setWatchNotice({ state: 'paused', since: T0 }));
        expect(screen.getByRole('status')).toHaveTextContent(COLLISION_PAUSED_NOTICE);
        act(() => AisGuardAlertStore.setWatchNotice({ state: 'watching', since: T0 }));
        expect(screen.queryByRole('status')).toBeNull();
    });

    it('after a pause it says how long it was not watching, until dismissed', () => {
        render(<AisGuardAlert />);
        act(() =>
            AisGuardAlertStore.setWatchNotice({
                state: 'resumed',
                since: T0,
                pausedFrom: T0,
                resumedAt: T0 + 27 * 60_000,
            }),
        );
        const notice = screen.getByRole('status');
        expect(notice).toHaveTextContent(/Collision watch was paused for 27 min while Thalassa was in the background/);
        fireEvent.click(within(notice).getByRole('button', { name: 'Dismiss collision watch notice' }));
        expect(screen.queryByRole('status')).toBeNull();
    });
});

describe('arming opens the sound check', () => {
    it('the shield opens the collision sound check instead of arming at once; cancelling leaves it off', async () => {
        render(<AisLegend visible />);
        fireEvent.click(screen.getByRole('button', { name: 'Enable AIS guard zone' }));
        const dialog = await screen.findByRole('dialog', { name: 'Sound check' });
        expect(dialog).toHaveTextContent('Start collision watch');
        expect(dialog).not.toHaveTextContent('Drop anchor');
        expect(hoisted.setEnabled).not.toHaveBeenCalled();
        fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel this action' }));
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Sound check' })).toBeNull());
        expect(hoisted.setEnabled).not.toHaveBeenCalled();
        expect(hoisted.armAfterSoundCheck).not.toHaveBeenCalled();
    });

    it('arms only after the real alarm was played and heard', async () => {
        vi.spyOn(AlarmAudioService, 'acquire').mockResolvedValue('collision-check-lease');
        vi.spyOn(AlarmAudioService, 'release').mockResolvedValue(undefined);
        render(<AisLegend visible />);
        fireEvent.click(screen.getByRole('button', { name: 'Enable AIS guard zone' }));
        const dialog = await screen.findByRole('dialog', { name: 'Sound check' });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Play test alarm' }));
        fireEvent.click(await within(dialog).findByRole('button', { name: 'Stop test alarm' }));
        fireEvent.click(await within(dialog).findByRole('button', { name: 'Confirm alarm was audible' }));
        fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm selection' }));
        // Arms the ring and the collision alarm together, recorded as checked.
        await waitFor(() => expect(hoisted.armAfterSoundCheck).toHaveBeenCalledOnce());
        expect(hoisted.setEnabled).not.toHaveBeenCalled();
        // The real alarm service and stop path, under the sound check's own test lease.
        expect(AlarmAudioService.acquire).toHaveBeenCalledWith('anchor-sound-check');
    });

    it('disarming stays one tap', () => {
        hoisted.guard = { enabled: true, radiusNm: 2, alerts: [] };
        render(<AisLegend visible />);
        fireEvent.click(screen.getByRole('button', { name: 'Disable AIS guard zone' }));
        expect(hoisted.setEnabled).toHaveBeenCalledWith(false);
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it("the anchor's own sound check is unchanged", () => {
        render(<SoundCheckModal onConfirm={vi.fn()} onCancel={vi.fn()} />);
        const dialog = screen.getByRole('dialog', { name: 'Sound check' });
        expect(dialog).toHaveTextContent('Drop anchor');
        expect(dialog).toHaveTextContent('Before you anchor up, make sure your alarm will wake you.');
        expect(dialog).not.toHaveTextContent(/collision/i);
    });
});

describe('Settings → Preferences', () => {
    it('holds the inshore/offshore pair with the recommended defaults, and saves a change', async () => {
        vi.stubGlobal('__BUILD_STAMP__', '2026-10-09 00:00Z');
        const { GeneralTab } = await import('../components/settings/GeneralTab');
        const { DEFAULT_SETTINGS } = await import('../stores/settingsStore');
        const onSave = vi.fn();
        render(
            <GeneralTab
                settings={DEFAULT_SETTINGS}
                onSave={onSave}
                onLocationSelect={vi.fn()}
                onDetectLocation={vi.fn()}
                onShowFactoryReset={vi.fn()}
            />,
        );
        const offshoreCpa = screen.getByLabelText('Offshore CPA') as HTMLSelectElement;
        expect(offshoreCpa.value).toBe('0.5');
        expect((screen.getByLabelText('Offshore TCPA') as HTMLSelectElement).value).toBe('15');
        expect((screen.getByLabelText('Inshore CPA') as HTMLSelectElement).value).toBe('0.2');
        expect((screen.getByLabelText('Inshore TCPA') as HTMLSelectElement).value).toBe('6');

        const section = offshoreCpa.closest('section') ?? offshoreCpa.parentElement!.parentElement!.parentElement!;
        expect(section.textContent).toMatch(/from 3 kn, inshore again below 2\.5 kn/);
        // Exact about when it can sound: under way only, close quarters included.
        expect(section.textContent).toMatch(/While you make 0\.5 kn or more/);
        expect(section.textContent).toMatch(/Close quarters .*always sounds then/);
        // 125-01b: plain about the two ways of being stopped.
        expect(section.textContent).toContain('Stopped at a berth: the collision alarm stays quiet.');
        expect(section.textContent).toContain(
            'At anchor (anchor watch on): it still sounds for a vessel under way coming within 0.1 NM.',
        );
        expect(section.textContent).not.toMatch(/Stopped, it stays quiet and says so/);
        // Locked, it watches only while something keeps Thalassa running: the Pi's watch does not.
        expect(section.textContent).toMatch(
            /a voyage track keeps it running under way, an anchor watch kept on this phone at anchor/,
        );
        // Honest about iOS: no promise beyond what a Time Sensitive notification delivers.
        expect(section.textContent).toMatch(/Time Sensitive/);
        expect(section.textContent).not.toMatch(/Critical Alert|always wakes|guaranteed/i);
        expect(section.textContent).not.toMatch(/Australia|Queensland|AMSA/);

        fireEvent.change(offshoreCpa, { target: { value: '1' } });
        expect(onSave).toHaveBeenCalledWith({
            collisionAlarm: { offshore: { cpaNm: 1, tcpaMin: 15 }, inshore: { cpaNm: 0.2, tcpaMin: 6 } },
        });
        vi.unstubAllGlobals();
    });
});
