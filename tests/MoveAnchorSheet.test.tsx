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

const service = vi.hoisted(() => ({ relocateAnchor: vi.fn() }));
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

import { MoveAnchorSheet } from '../components/anchor-watch/MoveAnchorSheet';
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
});
