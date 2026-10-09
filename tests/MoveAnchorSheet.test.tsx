/**
 * The Move anchor sheet: "Anchor is [39] m from the boat, bearing [212] °T".
 *
 * The anchor watch is armed wherever the GPS is, which is usually the BOAT, a
 * rode-length from the hook. This sheet puts the centre where the anchor
 * really is, measured from the boat, and says before anything moves whether
 * the boat would then be inside the swing circle.
 *
 * Worldwide, not just home waters: a Mediterranean anchorage in metres, a
 * Caribbean one in feet (west longitudes), a Norwegian one where a degree of
 * longitude is half what it is at the equator, and Fiji on and across 180°.
 * Bearings are degrees TRUE only, labelled as such; there is no magnetic model.
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { calculateDistance, destinationPoint } from '../utils/navigationCalculations';
import type { AnchorWatchConfig, AnchorWatchSnapshot } from '../services/AnchorWatchService';

const service = vi.hoisted(() => ({
    relocateAnchor: vi.fn(),
    relocateAnchorFromAlarm: vi.fn(),
    checkMoveFromAlarm: vi.fn(),
}));
vi.mock('../services/AnchorWatchService', () => ({
    AnchorWatchService: service,
    ANCHOR_RELOCATE_FIX_MAX_AGE_MS: 30_000,
}));

const nmea = vi.hoisted(() => ({
    state: {
        headingTrue: { value: null as number | null, lastUpdated: 0, freshness: 'dead' },
        remote: null as null | { source: 'pi' | 'device'; via: 'lan' | 'cloud' },
        connectionStatus: 'connected',
    },
}));
vi.mock('../services/NmeaStore', () => ({ NmeaStore: { getState: () => nmea.state } }));

// The radar itself draws on a canvas jsdom cannot paint; what matters here is
// WHERE the sheet asks it to put the preview anchor. The offset maths the
// canvas uses is exported and tested for real below.
vi.mock('../components/anchor-watch/SwingCircleCanvas', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../components/anchor-watch/SwingCircleCanvas')>();
    return {
        ...actual,
        SwingCircleCanvas: (props: { previewAnchor?: { latitude: number; longitude: number } | null }) => (
            <div data-testid="swing-preview" data-preview={JSON.stringify(props.previewAnchor ?? null)} />
        ),
    };
});

import { MoveAnchorSheet, type PiMoveSource } from '../components/anchor-watch/MoveAnchorSheet';
import { offsetFromAnchorM } from '../components/anchor-watch/SwingCircleCanvas';
import { useSettingsStore } from '../stores/settingsStore';

const NOW = Date.parse('2026-10-07T21:00:00Z');
const FT = 0.3048;

type LatLon = { latitude: number; longitude: number };

function chainRadius(config: AnchorWatchConfig): number {
    const reach = Math.sqrt(config.rodeLength ** 2 - config.waterDepth ** 2);
    return Math.max(reach * 0.85 + config.safetyMargin, 20);
}

/** The late-set case: the watch was armed at the boat, so the anchor sits under her. */
function snapshotAt(boat: LatLon, config: AnchorWatchConfig, overrides: Partial<AnchorWatchSnapshot> = {}) {
    return {
        state: 'watching',
        anchorPosition: { ...boat, timestamp: NOW - 600_000 },
        vesselPosition: { ...boat, accuracy: 4, heading: 0, speed: 0, timestamp: NOW - 1_000 },
        swingRadius: chainRadius(config),
        distanceFromAnchor: 0,
        maxDistanceRecorded: 3,
        bearingToAnchor: 0,
        config,
        positionHistory: [],
        alarmTriggeredAt: null,
        alarmCause: null,
        watchStartedAt: NOW - 600_000,
        gpsAccuracy: 4,
        gpsQuality: 'standard',
        gpsQualityLabel: 'Standard GPS',
        guardianStatus: 'idle',
        setupError: null,
        ...overrides,
    } as AnchorWatchSnapshot;
}

function setUnits(length: 'm' | 'ft') {
    const settings = useSettingsStore.getState().settings;
    useSettingsStore.setState({ settings: { ...settings, units: { ...settings.units, length } } });
}

function heading(value: number | null, ageMs: number, remote: (typeof nmea.state)['remote'] = null) {
    nmea.state.headingTrue = { value, lastUpdated: value === null ? 0 : NOW - ageMs, freshness: 'live' };
    nmea.state.remote = remote;
}

const distanceField = () => screen.getByRole('textbox', { name: /distance from the boat to the anchor/i });
const bearingField = () => screen.getByRole('textbox', { name: /bearing from the boat to the anchor/i });
const moveButton = () => screen.getByRole('button', { name: 'Move anchor' });
const liveLine = () => screen.getByRole('status');
const previewAnchor = () => JSON.parse(screen.getByTestId('swing-preview').dataset.preview ?? 'null');

function type(field: HTMLElement, value: string) {
    fireEvent.change(field, { target: { value } });
}

async function move() {
    await act(async () => {
        fireEvent.click(moveButton());
    });
}

function expectRelocatedTo(target: { lat: number; lon: number }) {
    expect(service.relocateAnchor).toHaveBeenCalledTimes(1);
    const [lat, lon] = service.relocateAnchor.mock.calls[0];
    expect(lat).toBeCloseTo(target.lat, 9);
    expect(lon).toBeCloseTo(target.lon, 9);
    return { lat: lat as number, lon: lon as number };
}

const metresBetween = (a: LatLon, b: { lat: number; lon: number }) =>
    calculateDistance(a.latitude, a.longitude, b.lat, b.lon) * 1852;

describe('MoveAnchorSheet', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
        service.relocateAnchor.mockReset().mockResolvedValue({ ok: true });
        service.relocateAnchorFromAlarm.mockReset().mockResolvedValue({ ok: true });
        service.checkMoveFromAlarm.mockReset().mockReturnValue({ ok: true, spreadM: 1, lateM: 33 });
        heading(null, 0);
        setUnits('m');
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('Marseille, in metres', () => {
        const boat = { latitude: 43.295, longitude: 5.36 };
        const config: AnchorWatchConfig = {
            rodeLength: 40,
            waterDepth: 8,
            scopeRatio: 5,
            rodeType: 'chain',
            safetyMargin: 10,
        };

        it('prefills where the rode lies and a fresh true heading, and says where each came from', () => {
            heading(212, 4_000);
            render(<MoveAnchorSheet snapshot={snapshotAt(boat, config)} onClose={vi.fn()} />);

            expect(screen.getByRole('dialog', { name: 'Move anchor' })).toBeInTheDocument();
            // √(40² − 8²) = 39.19 m of reach, less the chain's sag as the circle
            // reckons it (× 0.85): 33.3 m, the 43.3 m circle less its 10 m margin.
            expect(distanceField()).toHaveValue('33');
            expect(bearingField()).toHaveValue('212');
            expect(screen.getByText('°T')).toBeInTheDocument();
            const hint = screen.getByTestId('move-anchor-hint');
            expect(hint).toHaveTextContent(/rode \(40 m in 8 m\), less its sag/i);
            expect(hint).toHaveTextContent(/heading/i);
            expect(hint).toHaveTextContent(/4 s ago/);
            expect(hint).toHaveTextContent(/true, not magnetic/i);
            expect(liveLine()).toHaveTextContent('The boat would be 33 m from the anchor, inside your 43 m circle.');
        });

        it('moves the anchor to the point that distance and bearing describe, then says so', async () => {
            heading(212, 4_000);
            const onMoved = vi.fn();
            render(<MoveAnchorSheet snapshot={snapshotAt(boat, config)} onClose={vi.fn()} onMoved={onMoved} />);
            const expected = destinationPoint(boat.latitude, boat.longitude, 212, 33 / 1852);
            expect(previewAnchor()).toEqual({ latitude: expected.lat, longitude: expected.lon });

            await move();

            expectRelocatedTo(expected);
            expect(onMoved).toHaveBeenCalledTimes(1);
        });

        it('takes a decimal comma, as half the world writes it', async () => {
            heading(212, 4_000);
            render(<MoveAnchorSheet snapshot={snapshotAt(boat, config)} onClose={vi.fn()} />);
            type(distanceField(), '12,5');
            await move();
            expectRelocatedTo(destinationPoint(boat.latitude, boat.longitude, 212, 12.5 / 1852));
        });

        it('does not guess a bearing from a stale heading: the skipper enters it', async () => {
            heading(212, 11_000);
            render(<MoveAnchorSheet snapshot={snapshotAt(boat, config)} onClose={vi.fn()} />);

            expect(bearingField()).toHaveValue('');
            expect(screen.getByTestId('move-anchor-hint')).toHaveTextContent(/enter the bearing/i);
            expect(screen.getByTestId('move-anchor-hint')).toHaveTextContent(/true, not magnetic/i);
            expect(moveButton()).toBeDisabled();

            type(bearingField(), '95');
            expect(moveButton()).toBeEnabled();
            await move();
            expectRelocatedTo(destinationPoint(boat.latitude, boat.longitude, 95, 33 / 1852));
        });

        it.each([
            ['negative', '-3'],
            ['zero', '0'],
            ['not a number', 'abc'],
        ])('will not move on a %s distance', (_label, value) => {
            heading(212, 4_000);
            render(<MoveAnchorSheet snapshot={snapshotAt(boat, config)} onClose={vi.fn()} />);
            type(distanceField(), value);
            expect(moveButton()).toBeDisabled();
            expect(liveLine()).toHaveTextContent(/enter the distance/i);
        });

        it('never says "43 m … outside your 43 m circle": a tie gets a decimal', () => {
            heading(212, 4_000);
            render(<MoveAnchorSheet snapshot={snapshotAt(boat, config)} onClose={vi.fn()} />);
            type(distanceField(), '43.4');
            expect(liveLine()).toHaveTextContent(
                'The boat would be 43.4 m from the anchor, outside your 43.3 m circle.',
            );
            expect(moveButton()).toBeDisabled();
        });

        it('will not move on a bearing past 360°', () => {
            heading(212, 4_000);
            render(<MoveAnchorSheet snapshot={snapshotAt(boat, config)} onClose={vi.fn()} />);
            type(bearingField(), '361');
            expect(moveButton()).toBeDisabled();
        });
    });

    // A boat at anchor swings, and her heading with her. A bearing taken from
    // the heading is only as good as its age, so a prefill that the skipper
    // has not touched keeps up with the heading, says its age as it grows,
    // and is not used once it is more than 10 s old.
    describe('a bearing taken from the heading stays fresh, or is not used', () => {
        const boat = { latitude: 43.295, longitude: 5.36 };
        const config: AnchorWatchConfig = {
            rodeLength: 40,
            waterDepth: 8,
            scopeRatio: 5,
            rodeType: 'chain',
            safetyMargin: 10,
        };

        beforeEach(() => {
            vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
            vi.setSystemTime(NOW);
        });

        /** The instruments send a new true heading, now. */
        const newHeading = (value: number) => {
            nmea.state.headingTrue = { value, lastUpdated: Date.now(), freshness: 'live' };
        };
        const tick = (ms: number) =>
            act(() => {
                vi.advanceTimersByTime(ms);
            });

        it('an untouched prefill follows the heading as the boat swings, and says its age as it is now', async () => {
            heading(212, 3_000);
            render(<MoveAnchorSheet snapshot={snapshotAt(boat, config)} onClose={vi.fn()} />);
            expect(bearingField()).toHaveValue('212');
            expect(screen.getByTestId('move-anchor-hint')).toHaveTextContent(/3 s ago/);

            // She swings to 250°T; the field keeps up.
            tick(2_000);
            newHeading(250);
            tick(4_000);
            expect(bearingField()).toHaveValue('250');
            expect(screen.getByTestId('move-anchor-hint')).toHaveTextContent(/4 s ago/);
            expect(moveButton()).toBeEnabled();

            await move();
            expectRelocatedTo(destinationPoint(boat.latitude, boat.longitude, 250, 33 / 1852));
        });

        it('once the heading is more than 10 s old, an untouched prefill is not used', async () => {
            heading(212, 3_000);
            const { rerender } = render(<MoveAnchorSheet snapshot={snapshotAt(boat, config)} onClose={vi.fn()} />);
            expect(moveButton()).toBeEnabled();
            // The boat's GPS keeps reporting; only the heading goes quiet.
            const freshFix = () =>
                rerender(
                    <MoveAnchorSheet
                        snapshot={snapshotAt(boat, config, {
                            vesselPosition: { ...boat, accuracy: 4, heading: 0, speed: 0, timestamp: Date.now() },
                        })}
                        onClose={vi.fn()}
                    />,
                );

            // A minute reading the preview, and the instruments go quiet.
            tick(60_000);
            freshFix();
            expect(moveButton()).toBeDisabled();
            expect(liveLine()).toHaveTextContent(/heading is 63 s old/i);
            expect(liveLine()).toHaveTextContent(/enter the bearing/i);
            expect(screen.getByTestId('move-anchor-hint')).not.toHaveTextContent(/3 s ago/);
            await move();
            expect(service.relocateAnchor).not.toHaveBeenCalled();

            // A bearing the skipper enters is theirs, and does not go stale.
            type(bearingField(), '212');
            expect(moveButton()).toBeEnabled();
            tick(60_000);
            freshFix();
            expect(moveButton()).toBeEnabled();
            await move();
            expect(service.relocateAnchor).toHaveBeenCalledTimes(1);
        });

        it('a bearing the skipper typed is not overwritten by a heading that arrives later', () => {
            heading(null, 0);
            render(<MoveAnchorSheet snapshot={snapshotAt(boat, config)} onClose={vi.fn()} />);
            type(bearingField(), '095');
            newHeading(180);
            tick(2_000);
            expect(bearingField()).toHaveValue('095');
        });

        it('an empty bearing fills from a heading that arrives while the sheet is open', () => {
            heading(null, 0);
            render(<MoveAnchorSheet snapshot={snapshotAt(boat, config)} onClose={vi.fn()} />);
            expect(bearingField()).toHaveValue('');
            newHeading(48);
            tick(1_000);
            expect(bearingField()).toHaveValue('048');
            expect(moveButton()).toBeEnabled();
        });

        it('waits for a fresh boat fix: one more than 30 s old cannot vouch for the move', () => {
            heading(212, 1_000);
            const snapshot = snapshotAt(boat, config, {
                vesselPosition: { ...boat, accuracy: 4, heading: 0, speed: 0, timestamp: NOW - 25_000 },
            });
            render(<MoveAnchorSheet snapshot={snapshot} onClose={vi.fn()} />);
            expect(moveButton()).toBeEnabled();
            newHeading(212);
            tick(6_000);
            newHeading(212);
            tick(1_000);
            expect(liveLine()).toHaveTextContent(/waiting for a fresh position fix/i);
            expect(moveButton()).toBeDisabled();
        });
    });

    // A long chain in deep water: the circle is the reach less the chain's sag
    // plus the margin, so the full reach can lie OUTSIDE it (Norway, the
    // Pacific). The prefill must open inside the circle, not already refused.
    describe('a long chain in deep water', () => {
        const boat = { latitude: 62.47, longitude: 6.15 };

        it.each([
            ['80 m in 12 m', 80, 12, '67', '77'],
            ['80 m in 15 m', 80, 15, '67', '77'],
        ])('opens inside the circle (%s)', (_label, rodeLength, waterDepth, prefill, circle) => {
            heading(30, 1_000);
            const config: AnchorWatchConfig = {
                rodeLength,
                waterDepth,
                scopeRatio: rodeLength / waterDepth,
                rodeType: 'chain',
                safetyMargin: 10,
            };
            render(<MoveAnchorSheet snapshot={snapshotAt(boat, config)} onClose={vi.fn()} />);
            expect(distanceField()).toHaveValue(prefill);
            expect(liveLine()).toHaveTextContent(`inside your ${circle} m circle`);
            expect(moveButton()).toBeEnabled();
        });
    });

    describe('Grenada, in feet, west of Greenwich', () => {
        const boat = { latitude: 12.005, longitude: -61.77 };
        const config: AnchorWatchConfig = {
            rodeLength: 30,
            waterDepth: 4,
            scopeRatio: 7.5,
            rodeType: 'chain',
            safetyMargin: 10,
        };

        beforeEach(() => setUnits('ft'));

        it('speaks feet throughout and moves by feet converted to metres', async () => {
            heading(40, 2_000);
            render(<MoveAnchorSheet snapshot={snapshotAt(boat, config)} onClose={vi.fn()} />);
            // √(30² − 4²) = 29.73 m of reach × 0.85 = 25.27 m = 82.9 ft
            expect(distanceField()).toHaveValue('83');
            expect(distanceField()).toHaveAccessibleName(/in feet/i);
            expect(screen.getByTestId('move-anchor-hint')).toHaveTextContent(/rode \(98 ft in 13 ft\)/i);

            type(distanceField(), '60');
            type(bearingField(), '045');
            // 35.27 m = 115.7 ft
            expect(liveLine()).toHaveTextContent('The boat would be 60 ft from the anchor, inside your 116 ft circle.');

            await move();
            const target = expectRelocatedTo(destinationPoint(boat.latitude, boat.longitude, 45, (60 * FT) / 1852));
            // North-east: east of the boat, and still west of Greenwich.
            expect(target.lon).toBeGreaterThan(boat.longitude);
            expect(target.lon).toBeLessThan(0);
            expect(target.lat).toBeGreaterThan(boat.latitude);
            expect(metresBetween(boat, target)).toBeCloseTo(60 * FT, 3);
        });

        it('refuses, in plain words, a point that would leave the boat outside the circle', async () => {
            heading(40, 2_000);
            render(<MoveAnchorSheet snapshot={snapshotAt(boat, config)} onClose={vi.fn()} />);
            type(distanceField(), '150');

            expect(liveLine()).toHaveTextContent(
                'The boat would be 150 ft from the anchor, outside your 116 ft circle.',
            );
            expect(liveLine()).toHaveTextContent(/alarm would sound/i);
            expect(moveButton()).toBeDisabled();
            await move();
            expect(service.relocateAnchor).not.toHaveBeenCalled();
        });
    });

    describe('Bergen, 60°N: a degree of longitude is half the equator’s', () => {
        const boat = { latitude: 60.394, longitude: 5.32 };
        const config: AnchorWatchConfig = {
            rodeLength: 35,
            waterDepth: 7,
            scopeRatio: 5,
            rodeType: 'mixed',
            safetyMargin: 8,
        };

        it('scales an easterly move by the cosine of the latitude, on the sheet and on the preview', async () => {
            heading(90, 3_000, { source: 'pi', via: 'lan' });
            render(<MoveAnchorSheet snapshot={snapshotAt(boat, config)} onClose={vi.fn()} />);
            expect(screen.getByTestId('move-anchor-hint')).toHaveTextContent(/via the Pi/i);
            type(distanceField(), '30');

            await move();

            const target = expectRelocatedTo(destinationPoint(boat.latitude, boat.longitude, 90, 30 / 1852));
            const equatorDeg = (30 / 6_371_000.4) * (180 / Math.PI);
            const deltaLon = target.lon - boat.longitude;
            expect(deltaLon / equatorDeg).toBeCloseTo(1 / Math.cos((boat.latitude * Math.PI) / 180), 3);
            expect(Math.abs(target.lat - boat.latitude)).toBeLessThan(1e-5);
            expect(metresBetween(boat, target)).toBeCloseTo(30, 3);

            // The radar draws the boat 30 m WEST of the previewed anchor.
            expect(previewAnchor()).toEqual({ latitude: target.lat, longitude: target.lon });
            const offset = offsetFromAnchorM({ latitude: target.lat, longitude: target.lon }, boat);
            expect(offset.dx).toBeCloseTo(-30, 0);
            expect(Math.abs(offset.dy)).toBeLessThan(0.5);
        });
    });

    describe('Fiji: 179.95°E, and across 180°', () => {
        const config: AnchorWatchConfig = {
            rodeLength: 50,
            waterDepth: 10,
            scopeRatio: 5,
            rodeType: 'chain',
            safetyMargin: 20,
        };

        it('moves at 179.95°E like anywhere else', async () => {
            const boat = { latitude: -16.8, longitude: 179.95 };
            heading(90, 1_000);
            render(<MoveAnchorSheet snapshot={snapshotAt(boat, config)} onClose={vi.fn()} />);
            type(distanceField(), '40');
            await move();
            const target = expectRelocatedTo(destinationPoint(boat.latitude, boat.longitude, 90, 40 / 1852));
            expect(target.lon).toBeGreaterThan(179.95);
            expect(target.lon).toBeLessThan(180);
        });

        it('wraps an anchor dropped across the antimeridian, and the circle check still holds', async () => {
            const boat = { latitude: -16.8, longitude: 179.9998 };
            heading(90, 1_000);
            render(<MoveAnchorSheet snapshot={snapshotAt(boat, config)} onClose={vi.fn()} />);
            type(distanceField(), '60');
            // 60 m, not 40 000 km: the check measures across 180°.
            expect(liveLine()).toHaveTextContent('The boat would be 60 m from the anchor, inside your');

            await move();

            const target = expectRelocatedTo(destinationPoint(boat.latitude, boat.longitude, 90, 60 / 1852));
            expect(target.lon).toBeLessThan(-179.999);
            expect(target.lon).toBeGreaterThanOrEqual(-180);
            expect(metresBetween(boat, target)).toBeCloseTo(60, 3);

            // The radar wraps too: the boat is drawn 60 m west of the anchor,
            // not 40 000 km away off the edge of the screen.
            const offset = offsetFromAnchorM({ latitude: target.lat, longitude: target.lon }, boat);
            expect(offset.dx).toBeCloseTo(-60, 0);
            expect(offsetFromAnchorM(boat, { latitude: target.lat, longitude: target.lon }).dx).toBeCloseTo(60, 0);
        });
    });

    describe('what it will not do', () => {
        const boat = { latitude: 43.295, longitude: 5.36 };
        const config: AnchorWatchConfig = {
            rodeLength: 40,
            waterDepth: 8,
            scopeRatio: 5,
            rodeType: 'chain',
            safetyMargin: 10,
        };

        it('does not move while the alarm sounds', () => {
            heading(212, 4_000);
            render(
                <MoveAnchorSheet
                    snapshot={snapshotAt(boat, config, { state: 'alarm', alarmCause: 'drag' })}
                    onClose={vi.fn()}
                />,
            );
            expect(liveLine()).toHaveTextContent(/silence the alarm/i);
            expect(moveButton()).toBeDisabled();
        });

        it('does not move without a position fix to measure from', () => {
            heading(212, 4_000);
            render(<MoveAnchorSheet snapshot={snapshotAt(boat, config, { vesselPosition: null })} onClose={vi.fn()} />);
            expect(liveLine()).toHaveTextContent(/waiting for a position fix/i);
            expect(moveButton()).toBeDisabled();
        });

        it('shows the watch’s own refusal and stays open', async () => {
            heading(212, 4_000);
            service.relocateAnchor.mockResolvedValue({
                ok: false,
                error: 'Silence the alarm before moving the anchor.',
            });
            const onMoved = vi.fn();
            const onClose = vi.fn();
            render(<MoveAnchorSheet snapshot={snapshotAt(boat, config)} onClose={onClose} onMoved={onMoved} />);
            await move();
            expect(screen.getByRole('alert')).toHaveTextContent('Silence the alarm before moving the anchor.');
            expect(onMoved).not.toHaveBeenCalled();
            expect(onClose).not.toHaveBeenCalled();
            expect(screen.getByRole('dialog', { name: 'Move anchor' })).toBeInTheDocument();
        });

        it('is a centred dialog, clear of the tab bar, that lifts above the keyboard', () => {
            render(<MoveAnchorSheet snapshot={snapshotAt(boat, config)} onClose={vi.fn()} />);
            const dialog = screen.getByRole('dialog', { name: 'Move anchor' });
            expect(dialog).toHaveClass('thalassa-keyboard-safe-sheet');
            const overlay = dialog.parentElement!;
            expect(overlay).toHaveClass('items-center', 'justify-center');
            expect(overlay.className).toContain('pb-[calc(4rem+env(safe-area-inset-bottom)+1rem)]');
            expect(distanceField()).toHaveAttribute('inputmode', 'decimal');
            expect(bearingField()).toHaveAttribute('inputmode', 'numeric');
            expect(bearingField()).toHaveAccessibleName(/degrees true/i);
        });

        it('Cancel and Escape close it without moving anything', () => {
            const onClose = vi.fn();
            render(<MoveAnchorSheet snapshot={snapshotAt(boat, config)} onClose={onClose} />);
            fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
            fireEvent.keyDown(document, { key: 'Escape' });
            expect(onClose).toHaveBeenCalledTimes(2);
            expect(service.relocateAnchor).not.toHaveBeenCalled();
        });
    });

    // Build 125 (125-03): the same sheet, opened from the ALARM screen. A late
    // set swings her out of a circle centred in the wrong place, and the alarm
    // sounds although nothing has moved. The sheet moves the mark and stops
    // the alarm, but only when her swing track backs it up, and it says so
    // live, before the tap. The watch judges her track
    // (AnchorWatchService.checkMoveFromAlarm; tests/anchorLateSet.test.ts and
    // tests/AnchorMoveFromAlarm.test.ts); here it is a stand-in, and the sheet
    // shows what it says. It never promises it can always tell.
    describe('alarm mode: move the anchor from the alarm', () => {
        const config: AnchorWatchConfig = {
            rodeLength: 40,
            waterDepth: 8,
            scopeRatio: 5,
            rodeType: 'chain',
            safetyMargin: 10,
        };
        const LIE = Math.sqrt(40 ** 2 - 8 ** 2) * 0.85;
        const MIN = 60_000;
        // Off the Frioul islands, Marseille. The anchor is 33 m at 212°T from the boat.
        const boat = { latitude: 43.28, longitude: 5.305 };
        const toward = (from: LatLon, bearingDeg: number, metres: number): LatLon => {
            const p = destinationPoint(from.latitude, from.longitude, bearingDeg, metres / 1852);
            return { latitude: p.lat, longitude: p.lon };
        };
        const anchor = toward(boat, 212, LIE);
        /** Where the watch was armed: the boat, before a 120° wind shift swung her round. */
        const setAt = toward(anchor, 32 - 120, LIE);

        /** Fixes every 4 s, ending a second ago, at where(fraction of the trail). */
        function trail(minutes: number, where: (f: number) => LatLon) {
            const steps = Math.round((minutes * MIN) / 4_000);
            return Array.from({ length: steps + 1 }, (_, i) => ({
                ...where(i / steps),
                accuracy: 4,
                heading: 0,
                speed: 0,
                timestamp: NOW - 1_000 - (steps - i) * 4_000,
            }));
        }
        /** 14 minutes holding, then the wind backs 120° over 16. */
        const lateSet = () =>
            trail(30, (f) => toward(anchor, f < 14 / 30 ? 272 : 272 + 120 * ((f - 14 / 30) / (16 / 30)), LIE));

        function alarmSnapshot(history = lateSet(), overrides: Partial<AnchorWatchSnapshot> = {}) {
            const last = history[history.length - 1];
            return snapshotAt(setAt, config, {
                state: 'alarm',
                alarmCause: 'drag',
                alarmTriggeredAt: NOW - 60_000,
                vesselPosition: { ...last, timestamp: NOW - 1_000 },
                positionHistory: history,
                watchStartedAt: history[0].timestamp,
                ...overrides,
            });
        }
        const stopButton = () => screen.getByRole('button', { name: 'Move and stop alarm' });

        it('asks the skipper to be sure, and says before the tap that her swing fits', () => {
            heading(212, 2_000);
            render(<MoveAnchorSheet mode="alarm" snapshot={alarmSnapshot()} onClose={vi.fn()} />);
            expect(screen.getByRole('dialog', { name: 'Move anchor' })).toBeInTheDocument();
            expect(screen.getByTestId('move-anchor-caution')).toHaveTextContent(
                /only move it if you.re sure the anchor hasn.t moved/i,
            );
            expect(distanceField()).toHaveValue('33');
            expect(bearingField()).toHaveValue('212');
            expect(liveLine()).toHaveTextContent('The boat would be 33 m from the anchor, inside your 43 m circle.');
            expect(liveLine()).toHaveTextContent(/her track so far fits a swing round it/i);
            // Never a promise that the app can always tell.
            expect(document.body.textContent).not.toMatch(/not dragging|it was a late set|safe to move/i);
            expect(stopButton()).toBeEnabled();
        });

        it('moves the mark and stops the alarm through the alarm path, not the watch-page one', async () => {
            heading(212, 2_000);
            const onMoved = vi.fn();
            const snapshot = alarmSnapshot();
            render(<MoveAnchorSheet mode="alarm" snapshot={snapshot} onClose={vi.fn()} onMoved={onMoved} />);
            await act(async () => {
                fireEvent.click(stopButton());
            });
            expect(service.relocateAnchor).not.toHaveBeenCalled();
            expect(service.relocateAnchorFromAlarm).toHaveBeenCalledTimes(1);
            const [lat, lon] = service.relocateAnchorFromAlarm.mock.calls[0];
            const from = snapshot.vesselPosition!;
            const expected = destinationPoint(from.latitude, from.longitude, 212, 33 / 1852);
            expect(lat).toBeCloseTo(expected.lat, 9);
            expect(lon).toBeCloseTo(expected.lon, 9);
            expect(onMoved).toHaveBeenCalledTimes(1);
        });

        it('sits over the alarm screen: the critical layer, not the ordinary modal one', () => {
            heading(212, 2_000);
            const { unmount } = render(<MoveAnchorSheet mode="alarm" snapshot={alarmSnapshot()} onClose={vi.fn()} />);
            const overlay = screen.getByRole('dialog', { name: 'Move anchor' }).parentElement!;
            expect(overlay).toHaveAttribute('data-overlay-layer', 'critical');
            expect(overlay).toHaveClass('items-center', 'justify-center');
            expect(screen.getByRole('dialog', { name: 'Move anchor' })).toHaveClass('thalassa-keyboard-safe-sheet');
            unmount();
            render(<MoveAnchorSheet snapshot={snapshotAt(boat, config)} onClose={vi.fn()} />);
            expect(screen.getByRole('dialog', { name: 'Move anchor' }).parentElement).toHaveAttribute(
                'data-overlay-layer',
                'modal',
            );
        });

        it('asks the watch about the point the fields describe, live, as they change', () => {
            heading(212, 2_000);
            const snapshot = alarmSnapshot();
            render(<MoveAnchorSheet mode="alarm" snapshot={snapshot} onClose={vi.fn()} />);
            const from = snapshot.vesselPosition!;
            const asked = () => service.checkMoveFromAlarm.mock.calls[service.checkMoveFromAlarm.mock.calls.length - 1];
            let expected = destinationPoint(from.latitude, from.longitude, 212, 33 / 1852);
            expect(asked()[0]).toBeCloseTo(expected.lat, 9);
            expect(asked()[1]).toBeCloseTo(expected.lon, 9);
            fireEvent.change(distanceField(), { target: { value: '25' } });
            expected = destinationPoint(from.latitude, from.longitude, 212, 25 / 1852);
            expect(asked()[0]).toBeCloseTo(expected.lat, 9);
            expect(asked()[1]).toBeCloseTo(expected.lon, 9);
        });

        it('too early to tell, or a track this phone did not see: says what is missing, and will not move', () => {
            heading(212, 2_000);
            const lead = 'This phone has only 4 min of her track before the alarm.';
            service.checkMoveFromAlarm.mockReturnValue({
                ok: false,
                refusal: 'unseen',
                lead,
                error: `${lead} It needs 10 to tell a late set from a drag (the app restarted, or fixes stopped). If she is dragging, re-anchor.`,
            });
            render(<MoveAnchorSheet mode="alarm" snapshot={alarmSnapshot()} onClose={vi.fn()} />);
            expect(liveLine()).toHaveTextContent(
                'This phone has only 4 min of her track before the alarm. It needs 10 to tell a late set from a drag (the app restarted, or fixes stopped). If she is dragging, re-anchor.',
            );
            expect(stopButton()).toBeDisabled();
            // No point would pass, so how the fields were filled steps aside to make room.
            expect(screen.getByTestId('move-anchor-hint')).toHaveClass('hidden');
            expect(screen.getByTestId('move-anchor-caution')).toBeVisible();
        });

        it('a track that looks like a drag: says so, and will not move', async () => {
            heading(212, 2_000);
            const lead = 'Her distance from that point has been changing, the way a drag does.';
            service.checkMoveFromAlarm.mockReturnValue({
                ok: false,
                refusal: 'moving',
                lead,
                error: `${lead} If she is dragging, re-anchor.`,
            });
            render(<MoveAnchorSheet mode="alarm" snapshot={alarmSnapshot()} onClose={vi.fn()} />);
            expect(liveLine()).toHaveTextContent(`${lead} If she is dragging, re-anchor.`);
            // The second sentence is the part that steps aside for the keyboard.
            expect(screen.getByText('If she is dragging, re-anchor.', { exact: false }).tagName).toBe('SPAN');
            expect(stopButton()).toBeDisabled();
            // Another point might pass: the hint on how the fields were filled stays.
            expect(screen.getByTestId('move-anchor-hint')).not.toHaveClass('hidden');
            await act(async () => {
                fireEvent.click(stopButton());
            });
            expect(service.relocateAnchorFromAlarm).not.toHaveBeenCalled();
        });

        it('the watch-page sheet never asks: the trail check is the alarm’s alone', () => {
            heading(212, 2_000);
            render(<MoveAnchorSheet snapshot={snapshotAt(boat, config)} onClose={vi.fn()} />);
            expect(service.checkMoveFromAlarm).not.toHaveBeenCalled();
        });

        it('a GPS-lost alarm cannot be judged', () => {
            heading(212, 2_000);
            render(
                <MoveAnchorSheet
                    mode="alarm"
                    snapshot={alarmSnapshot(undefined, { alarmCause: 'gps-lost' })}
                    onClose={vi.fn()}
                />,
            );
            expect(liveLine()).toHaveTextContent(/GPS/);
            expect(stopButton()).toBeDisabled();
        });

        it('a stale fix cannot vouch for it', () => {
            heading(212, 2_000);
            const history = lateSet();
            render(
                <MoveAnchorSheet
                    mode="alarm"
                    snapshot={alarmSnapshot(history, {
                        vesselPosition: { ...history[history.length - 1], timestamp: NOW - 31_000 },
                    })}
                    onClose={vi.fn()}
                />,
            );
            expect(liveLine()).toHaveTextContent(/waiting for a fresh position fix/i);
            expect(stopButton()).toBeDisabled();
        });

        it('in feet, for a feet skipper, and the move is still made in metres', async () => {
            setUnits('ft');
            heading(212, 2_000);
            render(<MoveAnchorSheet mode="alarm" snapshot={alarmSnapshot()} onClose={vi.fn()} />);
            // 33.3 m = 109 ft, inside the 43.3 m = 142 ft circle.
            expect(distanceField()).toHaveValue('109');
            expect(liveLine()).toHaveTextContent('inside your 142 ft circle');
            await act(async () => {
                fireEvent.click(stopButton());
            });
            const [lat, lon] = service.relocateAnchorFromAlarm.mock.calls[0];
            expect(metresBetween(boat, { lat, lon })).toBeCloseTo(109 * FT, 3);
        });

        it('shows the watch’s own refusal and stays open, the alarm still sounding behind it', async () => {
            heading(212, 2_000);
            service.relocateAnchorFromAlarm.mockResolvedValue({
                ok: false,
                error: 'The anchor was not moved and the alarm is still sounding. Moving the swing circle did not respond within 15s.',
            });
            const onMoved = vi.fn();
            render(<MoveAnchorSheet mode="alarm" snapshot={alarmSnapshot()} onClose={vi.fn()} onMoved={onMoved} />);
            await act(async () => {
                fireEvent.click(stopButton());
            });
            expect(screen.getByRole('alert')).toHaveTextContent(/alarm is still sounding/i);
            expect(onMoved).not.toHaveBeenCalled();
        });
    });

    describe('pi mode: move the mark of the watch the Pi keeps (126-07a)', () => {
        // Off Horta, the Azores (fictional): the Pi's watch was set at the boat,
        // 40 m of rode in 8 m (a 39.2 m reach), a 45 m circle.
        const HORTA = { latitude: 38.53, longitude: -28.62 };
        const LYTTELTON = { latitude: -43.61, longitude: 172.72 };
        const toward = (from: LatLon, bearingDeg: number, metres: number) => {
            const p = destinationPoint(from.latitude, from.longitude, bearingDeg, metres / 1852);
            return { latitude: p.lat, longitude: p.lon };
        };

        function source(at: LatLon = HORTA, overrides: Partial<PiMoveSource> = {}): PiMoveSource {
            return {
                anchor: at,
                boatFix: { ...at, timestamp: NOW - 4_000 },
                swingRadius: 45,
                rodeLength: 40,
                waterDepth: 8,
                centreAtSet: at,
                ashore: false,
                alarm: false,
                gpsLost: false,
                ...overrides,
            };
        }
        const onPiMove = vi.fn();
        beforeEach(() => {
            onPiMove.mockReset().mockResolvedValue({ ok: true, ashore: false });
        });

        it('prefills from the rode and depth the Pi reports, and checks with the Pi’s guards', () => {
            heading(220, 3_000, { source: 'pi', via: 'lan' });
            render(<MoveAnchorSheet mode="pi" pi={source()} onPiMove={onPiMove} onClose={vi.fn()} />);
            expect(screen.getByRole('dialog', { name: 'Move anchor' })).toBeInTheDocument();
            // The 45 m circle less the 10 m margin the app arms with: 35 m, inside the 39.2 m reach.
            expect(distanceField()).toHaveValue('35');
            expect(bearingField()).toHaveValue('220');
            expect(screen.getByTestId('move-anchor-hint')).toHaveTextContent(/rode \(40 m in 8 m\), less its sag/i);
            expect(screen.getByTestId('move-anchor-hint')).toHaveTextContent(/via the Pi/);
            expect(liveLine()).toHaveTextContent('The boat would be 35 m from the anchor, inside your 45 m circle.');
            expect(moveButton()).toBeEnabled();
        });

        it('in feet for a feet skipper off Lyttelton, with the bearing via the cloud ashore, and moves in metres', async () => {
            setUnits('ft');
            heading(300, 2_000, { source: 'pi', via: 'cloud' });
            render(
                <MoveAnchorSheet
                    mode="pi"
                    pi={source(LYTTELTON, { ashore: true })}
                    onPiMove={onPiMove}
                    onClose={vi.fn()}
                />,
            );
            // 35 m = 115 ft, inside the 45 m = 148 ft circle; 40 m in 8 m = 131 ft in 26 ft.
            expect(distanceField()).toHaveValue('115');
            expect(liveLine()).toHaveTextContent('inside your 148 ft circle');
            expect(screen.getByTestId('move-anchor-hint')).toHaveTextContent(/131 ft in 26 ft/);
            expect(screen.getByTestId('move-anchor-hint')).toHaveTextContent(/via the cloud/);
            await move();
            expect(onPiMove).toHaveBeenCalledTimes(1);
            const [lat, lon] = onPiMove.mock.calls[0];
            expect(metresBetween(LYTTELTON, { lat, lon })).toBeCloseTo(115 * FT, 3);
            expect(service.relocateAnchor).not.toHaveBeenCalled();
            expect(service.relocateAnchorFromAlarm).not.toHaveBeenCalled();
        });

        it('starts the distance empty when the Pi has no rode for the watch (an older Pi)', () => {
            heading(220, 3_000);
            render(
                <MoveAnchorSheet
                    mode="pi"
                    pi={source(HORTA, { rodeLength: undefined, waterDepth: undefined })}
                    onPiMove={onPiMove}
                    onClose={vi.fn()}
                />,
            );
            expect(distanceField()).toHaveValue('');
            expect(moveButton()).toBeDisabled();
        });

        it('the live line is the Pi’s judgement: past the rode’s reach from where the watch was set', () => {
            heading(220, 3_000);
            // She lies 30 m out; 30 m further is 60 m from where it was set, past 39.2 + 15.
            const boat = toward(HORTA, 220, 30);
            render(
                <MoveAnchorSheet
                    mode="pi"
                    pi={source(HORTA, { boatFix: { ...boat, timestamp: NOW - 4_000 } })}
                    onPiMove={onPiMove}
                    onClose={vi.fn()}
                />,
            );
            type(distanceField(), '30');
            expect(liveLine()).toHaveTextContent(/beyond your rode.s reach from where the watch was set/i);
            expect(moveButton()).toBeDisabled();
            type(distanceField(), '20');
            expect(liveLine()).toHaveTextContent(/inside your 45 m circle/);
            expect(moveButton()).toBeEnabled();
        });

        it('waits for a fix from the Pi no more than 30 s old', () => {
            heading(220, 3_000);
            render(
                <MoveAnchorSheet
                    mode="pi"
                    pi={source(HORTA, { boatFix: { ...HORTA, timestamp: NOW - 31_000 } })}
                    onPiMove={onPiMove}
                    onClose={vi.fn()}
                />,
            );
            expect(liveLine()).toHaveTextContent(/waiting for a fresh position/i);
            expect(moveButton()).toBeDisabled();
        });

        it('says "Sent to the Pi…", then "Moved…" once the Pi’s own report shows the new point', async () => {
            heading(220, 3_000);
            const onMoved = vi.fn();
            const { rerender } = render(
                <MoveAnchorSheet mode="pi" pi={source()} onPiMove={onPiMove} onClose={vi.fn()} onMoved={onMoved} />,
            );
            await move();
            expect(liveLine()).toHaveTextContent(/^Sent to the Pi…/);
            expect(moveButton()).toBeDisabled();
            expect(onMoved).not.toHaveBeenCalled();

            const [lat, lon] = onPiMove.mock.calls[0];
            rerender(
                <MoveAnchorSheet
                    mode="pi"
                    pi={source(HORTA, { anchor: { latitude: lat, longitude: lon } })}
                    onPiMove={onPiMove}
                    onClose={vi.fn()}
                    onMoved={onMoved}
                />,
            );
            expect(liveLine()).toHaveTextContent('Moved. The Pi is watching the new point.');
            expect(onMoved).toHaveBeenCalledTimes(1);
        });

        it('says so honestly when the Pi took it but has not shown it after 30 s', async () => {
            vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
            vi.setSystemTime(NOW);
            heading(220, 3_000);
            const onMoved = vi.fn();
            render(<MoveAnchorSheet mode="pi" pi={source()} onPiMove={onPiMove} onClose={vi.fn()} onMoved={onMoved} />);
            await move();
            expect(liveLine()).toHaveTextContent(/^Sent to the Pi…/);
            act(() => {
                vi.advanceTimersByTime(31_000);
            });
            expect(liveLine()).toHaveTextContent(/hasn.t shown the new point yet/i);
            expect(liveLine()).not.toHaveTextContent(/^Moved/);
            expect(onMoved).not.toHaveBeenCalled();
        });

        it('a refusal: the Pi is still watching the old point, and the sheet stays open to try again', async () => {
            heading(220, 3_000);
            onPiMove.mockResolvedValue({
                ok: false,
                outcome: 'refused',
                error: 'The Pi is still watching the old point. Nothing was moved.',
            });
            const onMoved = vi.fn();
            render(<MoveAnchorSheet mode="pi" pi={source()} onPiMove={onPiMove} onClose={vi.fn()} onMoved={onMoved} />);
            await move();
            expect(liveLine()).toHaveTextContent('The Pi is still watching the old point. Nothing was moved.');
            expect(onMoved).not.toHaveBeenCalled();
            type(distanceField(), '30');
            expect(liveLine()).toHaveTextContent(/inside your 45 m circle/);
            expect(moveButton()).toBeEnabled();
        });

        it('no answer: says the Pi is watching one point or the other, and a later report settles it', async () => {
            heading(220, 3_000);
            onPiMove.mockResolvedValue({
                ok: false,
                outcome: 'unknown',
                error: 'The Pi didn’t answer. It is watching either the old or the new point; Shore Watch will show which within a minute.',
            });
            const onMoved = vi.fn();
            const { rerender } = render(
                <MoveAnchorSheet mode="pi" pi={source()} onPiMove={onPiMove} onClose={vi.fn()} onMoved={onMoved} />,
            );
            await move();
            expect(liveLine()).toHaveTextContent(
                /^The Pi didn’t answer\. It is watching either the old or the new point/,
            );
            expect(liveLine()).not.toHaveTextContent(/^Moved/);

            const [lat, lon] = onPiMove.mock.calls[0];
            rerender(
                <MoveAnchorSheet
                    mode="pi"
                    pi={source(HORTA, { anchor: { latitude: lat, longitude: lon } })}
                    onPiMove={onPiMove}
                    onClose={vi.fn()}
                    onMoved={onMoved}
                />,
            );
            expect(liveLine()).toHaveTextContent('Moved. The Pi is watching the new point.');
            expect(onMoved).toHaveBeenCalledTimes(1);
        });

        it('shows the keeper’s own refusal as an alert, and stays open', async () => {
            heading(220, 3_000);
            onPiMove.mockResolvedValue({
                ok: false,
                outcome: 'invalid',
                error: 'The Pi reports a drag alarm, so the anchor cannot be moved from here.',
            });
            render(<MoveAnchorSheet mode="pi" pi={source()} onPiMove={onPiMove} onClose={vi.fn()} />);
            await move();
            expect(screen.getByRole('alert')).toHaveTextContent(/drag alarm/);
            expect(screen.getByRole('dialog', { name: 'Move anchor' })).toBeInTheDocument();
        });

        it('asks the skipper to be sure only when the phone reaches the Pi from ashore', () => {
            heading(220, 3_000);
            const { unmount } = render(
                <MoveAnchorSheet mode="pi" pi={source()} onPiMove={onPiMove} onClose={vi.fn()} />,
            );
            expect(screen.queryByTestId('move-anchor-caution')).toBeNull();
            unmount();
            render(
                <MoveAnchorSheet
                    mode="pi"
                    pi={source(HORTA, { ashore: true })}
                    onPiMove={onPiMove}
                    onClose={vi.fn()}
                />,
            );
            expect(screen.getByTestId('move-anchor-caution')).toHaveTextContent(
                'Only move it if you’re sure the anchor hasn’t moved.',
            );
            // An ordinary modal, not the alarm's critical layer.
            expect(document.querySelector('[data-overlay-layer="critical"]')).toBeNull();
        });
    });
});
