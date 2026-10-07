/**
 * The look-ahead scrubber along the bottom of the chart.
 *
 * Shane 2026-09-17: "a scrubber along the bottom … the vessel going along the
 * route as its normal cruising speed". 2026-09-18: seven days, and a button to
 * change the model.
 *
 * A thumb on a moving boat is a blunt instrument: the whole track must take a
 * touch, both ends must be reachable exactly, and Play must stop at the end
 * rather than throw the ghost back onto the boat.
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

import {
    RouteTimeScrubber,
    fmtAhead,
    spreadBandPaths,
    type RouteTimeScrubberProps,
    type SpreadBandPoint,
} from '../components/passage/RouteTimeScrubber';
import { PassageHudInfoCard } from '../components/passage/PassageHudInfoCard';
import { getPassageHudInfo, setPassageSquallInfoVisible } from '../stores/passageHudInfoStore';

const HOUR = 3_600_000;
const NOW = new Date(2026, 8, 18, 9, 0, 0).getTime(); // a Friday, 09:00 local

// jsdom has no PointerEvent, so fireEvent.pointerDown arrives without a clientX.
// A MouseEvent of the same TYPE carries one, and React listens by type.
const pointer = (el: Element, type: 'pointerdown' | 'pointermove' | 'pointerup', clientX?: number) =>
    act(() => {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX }));
    });

const setup = (over: Partial<RouteTimeScrubberProps> = {}) => {
    const props: RouteTimeScrubberProps = {
        aheadMs: 0,
        maxMs: 20 * HOUR,
        endsAtArrival: true,
        playing: false,
        nowMs: NOW,
        windCoverageHours: null,
        modelLabel: 'ECMWF',
        modelProvider: 'ECMWF',
        cruiseKts: 6,
        onAhead: vi.fn(),
        onPlaying: vi.fn(),
        onLive: vi.fn(),
        onOpenModel: vi.fn(),
        ...over,
    };
    // System Status is a portal over the still-mounted chart. Render its info
    // card alongside the scrubber to verify the relocated detail content.
    const view = render(<RouteTimeScrubber {...props} />, {
        wrapper: ({ children }) => (
            <>
                {children}
                <PassageHudInfoCard />
            </>
        ),
    });
    const track = screen.getByTestId('route-scrub-track');
    // jsdom lays nothing out: give the track a box to be touched in.
    track.getBoundingClientRect = () =>
        ({ left: 100, width: 200, top: 0, right: 300, bottom: 28, height: 28, x: 100, y: 0, toJSON() {} }) as DOMRect;
    return { props, track, ...view };
};

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    setPassageSquallInfoVisible(false);
});

describe('what it says', () => {
    it('shows the CLOCK time she will be there — the offset is on the strip and on the ghost', () => {
        setup({ aheadMs: 6 * HOUR });
        expect(screen.getByTestId('route-scrub-moment').textContent).toBe('Fri 15:00');
    });

    it('has a visible LIVE return even when the separate instrument pane is minimized', () => {
        const { props } = setup({ aheadMs: 6 * HOUR, playing: true });
        const live = screen.getByRole('button', { name: 'Back to live conditions' });
        expect(live).toHaveTextContent('LIVE');
        fireEvent.click(live);
        expect(props.onPlaying).toHaveBeenCalledWith(false);
        expect(props.onLive).toHaveBeenCalledOnce();
        expect(props.onAhead).not.toHaveBeenCalled();
    });

    it('keeps the LIVE return available when no route time remains to scrub', () => {
        const { props } = setup({ maxMs: 0 });
        const live = screen.getByRole('button', { name: 'Back to live conditions' });
        expect(live).toBeEnabled();
        fireEvent.click(live);
        expect(props.onLive).toHaveBeenCalledOnce();
    });

    it('reads NOW at the start, minutes under the hour, days past two', () => {
        expect(fmtAhead(0)).toBe('NOW');
        expect(fmtAhead(25 * 60_000)).toBe('+25 min');
        expect(fmtAhead(6.5 * HOUR)).toBe('+6.5 h');
        expect(fmtAhead(48 * HOUR)).toBe('+2 d');
        expect(fmtAhead(75 * HOUR)).toBe('+3 d 3 h');
        expect(fmtAhead(7 * 24 * HOUR)).toBe('+7 d');
        expect(fmtAhead(0, true)).toBe('DEPART');
        expect(fmtAhead(30_000, true)).toBe('DEPART');
        expect(fmtAhead(6 * HOUR, true)).toBe('+6 h');
    });

    it('uses a fixed departure plus passage elapsed time, without drifting as now advances', () => {
        const departureMs = NOW + 24 * HOUR;
        const { props, rerender, track } = setup({ departureMs, aheadMs: 3 * HOUR });
        expect(screen.getByTestId('route-scrub-moment')).toHaveTextContent('Sat 12:00');
        expect(track).toHaveAttribute('aria-valuetext', 'Sat 12:00 · +3 h · departs Sat 09:00');
        rerender(<RouteTimeScrubber {...props} nowMs={NOW + 6 * HOUR} />);
        expect(screen.getByTestId('route-scrub-moment')).toHaveTextContent('Sat 12:00');
        expect(getPassageHudInfo()?.moment).toBe('Sat 12:00 · +3 h · departs Sat 09:00');
    });

    it('labels a future zero offset DEPART, not NOW, and retains its clock when edited', () => {
        const { props, track } = setup({ departureMs: NOW + 24 * HOUR, onOpenDeparture: vi.fn(), playing: true });
        expect(track).toHaveAttribute('aria-valuetext', 'Sat 09:00 · DEPART · departs Sat 09:00');
        const button = screen.getByRole('button', {
            name: 'Change departure time. Leaves Sat 09:00. Forecast Sat 09:00',
        });
        fireEvent.click(button);
        expect(props.onPlaying).toHaveBeenCalledWith(false);
        expect(props.onOpenDeparture).toHaveBeenCalledOnce();
        expect(vi.mocked(props.onPlaying).mock.invocationCallOrder[0]).toBeLessThan(
            vi.mocked(props.onOpenDeparture!).mock.invocationCallOrder[0],
        );
        expect(props.onAhead).not.toHaveBeenCalled();
        expect(props.onLive).not.toHaveBeenCalled();
    });

    it('credits the forecast’s source in the existing info panel, without truncation', () => {
        setup({ modelLabel: 'UKMO', modelProvider: 'UK Met Office' });
        const credit = screen.getByTestId('route-scrub-credit');
        expect(credit.textContent).toBe('Forecast data: UK Met Office');
        // It may wrap on a narrow phone. It may not be cut off with an ellipsis.
        expect(credit.className).not.toMatch(/truncate|line-clamp|text-ellipsis|overflow-hidden|whitespace-nowrap/);
        // UK Met Office data is CC BY-SA 4.0: its licence is named, not folded
        // into the CC BY link.
        expect(screen.getByRole('link', { name: 'CC BY-SA 4.0' })).toHaveAttribute(
            'href',
            'https://creativecommons.org/licenses/by-sa/4.0/',
        );
    });

    it('names no share-alike licence when no UK Met Office data is on screen', () => {
        setup({ aheadMs: 6 * HOUR });
        expect(screen.getByTestId('route-scrub-credit')).toHaveTextContent('Forecast data: ECMWF');
        expect(screen.queryByRole('link', { name: 'CC BY-SA 4.0' })).toBeNull();
    });

    it('keeps all explanations below the slider off the compact chart face', () => {
        setup({ aheadMs: 6 * HOUR, rainCoverageHours: 3.4, joining: true, unsyncedLayers: ['squalls'] });
        const scrubber = screen.getByTestId('route-time-scrubber');
        expect(scrubber).not.toHaveTextContent('Chart rain ends');
        expect(scrubber).not.toHaveTextContent('Forecast data:');
        expect(scrubber).not.toHaveTextContent('unchecked estimate');
        expect(scrubber).not.toHaveTextContent('own time');
        expect(scrubber.querySelectorAll('button')).toHaveLength(3); // Play, LIVE, model; no extra info FAB
        const details = screen.getByTestId('passage-hud-info');
        expect(details).toHaveTextContent('Chart rain ends +3.4 h');
        expect(details).toHaveTextContent('Joining route · unchecked estimate');
        expect(details).toHaveTextContent('Chart squalls: still at its own time');
        expect(details).toHaveTextContent('Forecast data: ECMWF');
        expect(screen.getByRole('link', { name: 'CC BY 4.0' })).toHaveAttribute(
            'href',
            'https://creativecommons.org/licenses/by/4.0/',
        );
    });

    it('clears the info descriptor when forecast mode ends, rather than retaining a stale forecast', () => {
        const { unmount } = setup({ aheadMs: 6 * HOUR });
        expect(getPassageHudInfo()?.moment).toBe('Fri 15:00 · +6 h');
        unmount();
        expect(getPassageHudInfo()).toBeNull();
    });

    it('updates the info panel when a model or coverage changes', () => {
        const { rerender, props } = setup({ aheadMs: 6 * HOUR, rainCoverageHours: 3.4 });
        rerender(<RouteTimeScrubber {...props} modelLabel="ICON" modelProvider="DWD" rainCoverageHours={8} />);
        expect(screen.queryByTestId('route-scrub-note')).toBeNull();
        expect(screen.getByTestId('route-scrub-credit')).toHaveTextContent('Forecast data: DWD');
        expect(screen.getByTestId('passage-hud-info')).toHaveTextContent('ICON');
        expect(screen.getByTestId('passage-hud-info')).toHaveTextContent('Rain imagery reaches +8.0 h.');
    });

    it('makes the squall key available from info even without a forecast scrubber', () => {
        setPassageSquallInfoVisible(true);
        render(<PassageHudInfoCard />);
        expect(screen.getByRole('contentinfo', { name: 'Squall intensity legend' })).toBeInTheDocument();
        expect(screen.getByTestId('passage-hud-info')).toHaveTextContent('Possible');
        expect(screen.getByTestId('passage-hud-info')).toHaveTextContent('Extreme');
        expect(screen.getByTestId('passage-hud-info')).toHaveTextContent('Heavy-rain proxy');
        expect(screen.getByTestId('passage-hud-info')).toHaveTextContent(
            'its own snapshot time, not the forecast boat’s future time',
        );
        expect(screen.queryByTestId('route-scrub-credit')).toBeNull();
        act(() => setPassageSquallInfoVisible(false));
        expect(screen.queryByTestId('passage-hud-info')).toBeNull();
    });

    it('names the model on the button that changes it', () => {
        const { props } = setup({ modelLabel: 'ICON' });
        const button = screen.getByTestId('route-scrub-model');
        expect(button.textContent).toContain('ICON');
        fireEvent.click(button);
        expect(props.onOpenModel).toHaveBeenCalled();
    });

    it('is a slider to a screen reader, valued in the words a skipper would use', () => {
        const { track } = setup({ aheadMs: 3 * HOUR });
        expect(track.getAttribute('role')).toBe('slider');
        expect(track.getAttribute('aria-valuetext')).toBe('Fri 12:00 · +3 h');
        expect(track.getAttribute('aria-valuemax')).toBe(String(20 * 60));
    });
});

describe('where the chart’s wind stops', () => {
    it('marks how far the wind FIELD reaches, and says so once the ghost has sailed past it', () => {
        setup({ maxMs: 100 * HOUR, aheadMs: 60 * HOUR, endsAtArrival: true, windCoverageHours: 46.4 });
        expect(screen.getByTestId('route-scrub-coverage').style.width).toBe('46.4%');
        expect(screen.getByTestId('route-scrub-note').textContent).toBe('Chart wind ends +46 h');
    });

    it('says nothing about it while the ghost is inside the field, or when the wind layer is off', () => {
        setup({ maxMs: 100 * HOUR, aheadMs: 10 * HOUR, windCoverageHours: 46 });
        expect(screen.queryByTestId('route-scrub-note')).toBeNull();
        cleanup();
        setup({ maxMs: 100 * HOUR, aheadMs: 60 * HOUR, windCoverageHours: null });
        expect(screen.queryByTestId('route-scrub-note')).toBeNull();
        expect(screen.queryByTestId('route-scrub-coverage')).toBeNull();
    });

    it('at the end of the axis it says WHICH end: she arrives, or the forecast runs out', () => {
        setup({ aheadMs: 20 * HOUR, endsAtArrival: true });
        expect(screen.getByTestId('route-scrub-note').textContent).toBe('Arrives, at 6.0 kn cruising');
        cleanup();
        setup({ maxMs: 168 * HOUR, aheadMs: 168 * HOUR, endsAtArrival: false });
        expect(screen.getByTestId('route-scrub-note').textContent).toBe('Seven days — the forecast stops here');
    });
});

describe('chart layers that are NOT at this moment', () => {
    it('says so by name: their own time pills are stood down, so nothing else on the glass can', () => {
        setup({ aheadMs: 6 * HOUR, unsyncedLayers: ['rain', 'currents'] });
        expect(screen.getByTestId('route-scrub-unsynced').textContent).toBe(
            'Chart rain, currents: still at their own time',
        );
        cleanup();
        setup({ aheadMs: 6 * HOUR, unsyncedLayers: ['rain'] });
        expect(screen.getByTestId('route-scrub-unsynced').textContent).toBe('Chart rain: still at its own time');
    });

    it('is not said at NOW, when their time IS this time — and not at all when every layer follows', () => {
        setup({ aheadMs: 0, unsyncedLayers: ['rain'] });
        expect(screen.queryByTestId('route-scrub-unsynced')).toBeNull();
        cleanup();
        setup({ aheadMs: 6 * HOUR });
        expect(screen.queryByTestId('route-scrub-unsynced')).toBeNull();
    });

    it('keeps own-time caveats at zero elapsed time for a scheduled future departure', () => {
        setup({
            departureMs: NOW + 72 * HOUR,
            aheadMs: 0,
            windCoverageHours: 0,
            rainCoverageHours: 0,
            unsyncedLayers: ['wind', 'rain', 'currents'],
        });
        expect(screen.getByTestId('route-scrub-unsynced')).toHaveTextContent(
            'Chart wind, rain, currents: still at their own time',
        );
        expect(screen.getByTestId('passage-hud-info')).toHaveTextContent('DEPART');
        expect(getPassageHudInfo()?.ownTime).toEqual(['wind', 'rain', 'currents']);
    });

    it('does not push the wind-field note off the glass: both honesty notes show together', () => {
        setup({ maxMs: 100 * HOUR, aheadMs: 60 * HOUR, windCoverageHours: 46, unsyncedLayers: ['rain'] });
        expect(screen.getByTestId('route-scrub-unsynced')).toBeTruthy();
        expect(screen.getByTestId('route-scrub-note').textContent).toContain('Chart wind ends +46 h');
    });
});

describe('under a thumb', () => {
    it('a touch ANYWHERE on the track moves it there, on five-minute marks', () => {
        const { props, track } = setup();
        pointer(track, 'pointerdown', 150);
        expect(props.onAhead).toHaveBeenLastCalledWith(5 * HOUR);
        pointer(track, 'pointermove', 151);
        // 0.255 of 20 h = 5 h 06 min → the 5 h 05 mark
        expect(props.onAhead).toHaveBeenLastCalledWith(5 * HOUR + 5 * 60_000);
    });

    it('both ends are reachable exactly, and a drag off the end stays on it', () => {
        const { props, track } = setup({ maxMs: 20 * HOUR + 123_456 });
        pointer(track, 'pointerdown', 900);
        expect(props.onAhead).toHaveBeenLastCalledWith(20 * HOUR + 123_456);
        pointer(track, 'pointermove', -50);
        expect(props.onAhead).toHaveBeenLastCalledWith(0);
    });

    it('does not move on a hover — only between down and up', () => {
        const { props, track } = setup();
        pointer(track, 'pointermove', 250);
        expect(props.onAhead).not.toHaveBeenCalled();
        pointer(track, 'pointerdown', 150);
        pointer(track, 'pointerup');
        (props.onAhead as ReturnType<typeof vi.fn>).mockClear();
        pointer(track, 'pointermove', 250);
        expect(props.onAhead).not.toHaveBeenCalled();
    });

    it('taking hold of it stops Play', () => {
        const { props, track } = setup({ playing: true });
        pointer(track, 'pointerdown', 150);
        expect(props.onPlaying).toHaveBeenCalledWith(false);
    });

    it('steps an hour with the arrow keys, six with Shift or Page, and jumps with Home and End', () => {
        const { props, track } = setup({ aheadMs: 6 * HOUR });
        fireEvent.keyDown(track, { key: 'ArrowRight' });
        expect(props.onAhead).toHaveBeenLastCalledWith(7 * HOUR);
        fireEvent.keyDown(track, { key: 'ArrowLeft', shiftKey: true });
        expect(props.onAhead).toHaveBeenLastCalledWith(0);
        fireEvent.keyDown(track, { key: 'PageUp' });
        expect(props.onAhead).toHaveBeenLastCalledWith(12 * HOUR);
        fireEvent.keyDown(track, { key: 'End' });
        expect(props.onAhead).toHaveBeenLastCalledWith(20 * HOUR);
        fireEvent.keyDown(track, { key: 'Home' });
        expect(props.onAhead).toHaveBeenLastCalledWith(0);
    });

    it('a touch that carries no position is ignored, not turned into NaN for three followers', () => {
        const { props, track } = setup();
        fireEvent.pointerDown(track, { pointerId: 1 });
        expect(props.onAhead).not.toHaveBeenCalled();
    });

    it('a passage with nothing left to scrub is a dead slider, not a divide by zero', () => {
        const { props, track } = setup({ maxMs: 0 });
        pointer(track, 'pointerdown', 150);
        fireEvent.keyDown(track, { key: 'ArrowRight' });
        expect(props.onAhead).not.toHaveBeenCalled();
        expect(track.getAttribute('aria-disabled')).toBe('true');
        expect((screen.getByTestId('route-scrub-play') as HTMLButtonElement).disabled).toBe(true);
    });
});

describe('Play', () => {
    it('walks forward and STOPS at the end — it never throws the ghost back onto the boat', () => {
        vi.useFakeTimers();
        let ahead = 19 * HOUR;
        const onAhead = vi.fn((ms: number) => {
            ahead = ms;
        });
        const onPlaying = vi.fn();
        const { rerender, props } = setup({ aheadMs: ahead, playing: true, onAhead, onPlaying });
        for (let i = 0; i < 40 && !onPlaying.mock.calls.length; i++) {
            act(() => {
                vi.advanceTimersByTime(100);
            });
            rerender(<RouteTimeScrubber {...props} aheadMs={ahead} playing onAhead={onAhead} onPlaying={onPlaying} />);
        }
        expect(ahead).toBe(20 * HOUR);
        expect(onPlaying).toHaveBeenCalledWith(false);
        const calls = onAhead.mock.calls.map(([ms]) => ms as number);
        expect(calls.every((ms, i) => i === 0 || ms >= calls[i - 1])).toBe(true);
    });

    it('crosses a week in about the same time as a day: a sweep, not a wait', () => {
        vi.useFakeTimers();
        const { props } = setup({ maxMs: 168 * HOUR, playing: true });
        act(() => {
            vi.advanceTimersByTime(100);
        });
        // 168 h / 24 s × 0.1 s = 0.7 h a tick
        expect(props.onAhead).toHaveBeenLastCalledWith(0.7 * HOUR);
    });

    it('pressed at the end, it starts again from now', () => {
        const { props } = setup({ aheadMs: 20 * HOUR });
        fireEvent.click(screen.getByTestId('route-scrub-play'));
        expect(props.onAhead).toHaveBeenCalledWith(0);
        expect(props.onPlaying).toHaveBeenCalledWith(true);
    });

    it('replays a fixed departure from zero passage elapsed time, not a new leave time', () => {
        const { props } = setup({ departureMs: NOW + 24 * HOUR, aheadMs: 20 * HOUR });
        const play = screen.getByRole('button', { name: 'Play again from departure' });
        fireEvent.click(play);
        expect(props.onAhead).toHaveBeenCalledWith(0);
        expect(props.onPlaying).toHaveBeenCalledWith(true);
        expect(props.onLive).not.toHaveBeenCalled();
    });
});

describe('the band: where it blows, and where the models stop agreeing', () => {
    const band: SpreadBandPoint[] = [
        { f: 0, minKts: 8, maxKts: 12, pinnedKts: 10, level: 'agree' },
        { f: 0.25, minKts: 9, maxKts: 20, pinnedKts: 11, level: 'split' },
        { f: 0.5, minKts: 10, maxKts: 24, pinnedKts: 12, level: 'split' },
        { f: 0.75, minKts: null, maxKts: null, pinnedKts: 14, level: 'none' }, // the others ran out
        { f: 1, minKts: null, maxKts: null, pinnedKts: null, level: 'none' },
    ];

    it('draws the range, marks the split stretch, and runs the pinned model’s own line through it', () => {
        setup({ spreadBand: band });
        expect(screen.getByTestId('route-scrub-band')).toBeTruthy();
        expect(screen.getAllByTestId('route-scrub-band-split')).toHaveLength(1);
    });

    it('does NOT draw across a gap: where the models ran out the band stops, it is not stretched to the end', () => {
        const paths = spreadBandPaths(band);
        expect(paths.band).toHaveLength(1);
        const xs = [...paths.band[0].matchAll(/(?:M|L)([\d.]+),/g)].map((m) => Number(m[1]));
        expect(Math.max(...xs)).toBe(50); // ends at the last point that HAS a range
        // …while the pinned model's line carries on for as long as IT has wind.
        expect(paths.line).toContain('75.00,');
        expect(paths.line).not.toContain('100.00,');
    });

    it('restarts the pinned-model line on each side of an internal gap, even while the envelope continues', () => {
        const points: SpreadBandPoint[] = [0, 0.25, 0.5, 0.75, 1].map((f) => ({
            f,
            minKts: 8,
            maxKts: 22,
            pinnedKts: f === 0.5 ? null : 10 + f * 10,
            level: 'agree',
        }));
        const paths = spreadBandPaths(points);
        expect(paths.band).toHaveLength(1);
        expect([...paths.line.matchAll(/M([\d.]+),/g)].map((match) => Number(match[1]))).toEqual([0, 75]);
        expect([...paths.line.matchAll(/L([\d.]+),/g)].map((match) => Number(match[1]))).toEqual([25, 100]);
        expect(paths.line).not.toContain('50.00,');
        // Isolated values do not manufacture a connecting stroke either.
        expect(spreadBandPaths([points[0], points[2], points[4]]).line).not.toContain('L');
    });

    it('a single point is not a band, and nothing is drawn with no spread at all', () => {
        expect(spreadBandPaths([band[0]]).band).toEqual([]);
        setup({ spreadBand: null });
        expect(screen.queryByTestId('route-scrub-band')).toBeNull();
    });

    it('scales to a little over the strongest wind in it — and never below 15 kn, so a drift is not drawn as a blow', () => {
        expect(spreadBandPaths(band).topKts).toBeCloseTo(24 * 1.15, 6);
        expect(spreadBandPaths([{ ...band[0], maxKts: 48 }, band[1]]).topKts).toBeCloseTo(48 * 1.15, 6);
        const drift: SpreadBandPoint[] = [
            { f: 0, minKts: 3, maxKts: 5, pinnedKts: 4, level: 'agree' },
            { f: 1, minKts: 4, maxKts: 6, pinnedKts: 5, level: 'agree' },
        ];
        expect(spreadBandPaths(drift).topKts).toBe(15);
    });

    it('costs the scrubber no height: it lives inside the track', () => {
        setup({ spreadBand: band });
        const svg = screen.getByTestId('route-scrub-band');
        expect(svg.parentElement).toBe(screen.getByTestId('route-scrub-track'));
        expect(svg.getAttribute('class')).toContain('absolute');
        expect(svg.getAttribute('class')).toContain('pointer-events-none');
    });

    it('credits EVERY provider whose numbers are in the band, the pinned model’s among them', () => {
        setup({ modelProvider: 'ECMWF', spreadProviders: ['DWD', 'ECMWF', 'UK Met Office', 'JMA'] });
        expect(screen.getByTestId('route-scrub-credit').textContent).toBe(
            'Forecast data: DWD, ECMWF, UK Met Office, JMA',
        );
        cleanup();
        // The pinned model answered on its own but was missing from the band: still named, first.
        setup({ modelProvider: 'JMA', spreadProviders: ['DWD', 'ECMWF'] });
        expect(screen.getByTestId('route-scrub-credit').textContent).toBe('Forecast data: JMA, DWD, ECMWF');
    });
});

describe('phase 3 notes', () => {
    it('says where the chart’s RAIN ends, once the ghost has sailed past it', () => {
        setup({ maxMs: 20 * HOUR, aheadMs: 6 * HOUR, rainCoverageHours: 3.7 });
        expect(screen.getByTestId('route-scrub-note').textContent).toBe('Chart rain ends +3.7 h');
        cleanup();
        setup({ maxMs: 20 * HOUR, aheadMs: 2 * HOUR, rainCoverageHours: 3.7 });
        expect(screen.queryByTestId('route-scrub-note')).toBeNull();
    });

    it('says when her speed is ASSUMED because the wind forecast has run out — only by the wind, only from there on', () => {
        setup({ maxMs: 100 * HOUR, aheadMs: 80 * HOUR, assumedFromMs: 70 * HOUR, arrivalEstimated: true });
        expect(screen.getByTestId('route-scrub-note').textContent).toBe('No wind forecast here — 6.0 kn assumed');
        cleanup();
        setup({ maxMs: 100 * HOUR, aheadMs: 60 * HOUR, assumedFromMs: 70 * HOUR, arrivalEstimated: true });
        expect(screen.queryByTestId('route-scrub-note')).toBeNull();
        cleanup();
        setup({ maxMs: 100 * HOUR, aheadMs: 80 * HOUR, assumedFromMs: 70 * HOUR, arrivalEstimated: false });
        expect(screen.queryByTestId('route-scrub-note')).toBeNull(); // flat speed assumes nothing about the wind
    });

    it('keeps missing route-forecast assumptions visible when chart imagery has also ended', () => {
        setup({
            departureMs: NOW + 120 * HOUR,
            maxMs: 100 * HOUR,
            aheadMs: 72 * HOUR,
            assumedFromMs: 48 * HOUR,
            arrivalEstimated: true,
            windCoverageHours: 0,
            rainCoverageHours: 0,
        });
        expect(screen.getByTestId('route-scrub-note')).toHaveTextContent(
            'No wind forecast here — 6.0 kn assumed · Chart wind ends +0 h',
        );
        expect(screen.getByTestId('route-scrub-note')).not.toHaveTextContent('numbers continue');
        expect(screen.getByTestId('route-scrub-unsynced')).toHaveTextContent('Chart rain: still at its own time');
    });

    it('an arrival worked from the wind is called an estimate; a flat-speed one names the speed', () => {
        setup({ aheadMs: 20 * HOUR, endsAtArrival: true, arrivalEstimated: true });
        expect(screen.getByTestId('route-scrub-note').textContent).toBe('Arrives — by the wind, an estimate');
        cleanup();
        setup({ aheadMs: 20 * HOUR, endsAtArrival: true, arrivalEstimated: false });
        expect(screen.getByTestId('route-scrub-note').textContent).toBe('Arrives, at 6.0 kn cruising');
    });
});

describe('what the review of phase 3 caught on the scrubber', () => {
    it('a split that is ALL ABOUT DIRECTION still paints red: five models at 18 kn from 80° apart have a range of nothing', () => {
        const band: SpreadBandPoint[] = [
            { f: 0, minKts: 18, maxKts: 18, pinnedKts: 18, level: 'split' },
            { f: 0.5, minKts: 18, maxKts: 18, pinnedKts: 18, level: 'split' },
            { f: 1, minKts: 18, maxKts: 18, pinnedKts: 18, level: 'agree' },
        ];
        const paths = spreadBandPaths(band);
        expect(paths.splitRule).toEqual(['M0.00,1.5 L75.00,1.5']);
        setup({ spreadBand: band });
        expect(screen.getAllByTestId('route-scrub-band-split')).toHaveLength(1);
        expect(screen.getByTestId('route-scrub-band-split').getAttribute('stroke-width')).toBe('3');
    });

    it('a split ONE SAMPLE long is not dropped: on a seven-day axis that sample is four hours', () => {
        const band: SpreadBandPoint[] = [
            { f: 0, minKts: 10, maxKts: 12, pinnedKts: 11, level: 'agree' },
            { f: 0.25, minKts: 10, maxKts: 12, pinnedKts: 11, level: 'agree' },
            { f: 0.5, minKts: 9, maxKts: 22, pinnedKts: 11, level: 'split' },
            { f: 0.75, minKts: 10, maxKts: 12, pinnedKts: 11, level: 'agree' },
            { f: 1, minKts: 10, maxKts: 12, pinnedKts: 11, level: 'agree' },
        ];
        // Half a step either side of the one sample.
        expect(spreadBandPaths(band).splitRule).toEqual(['M37.50,1.5 L62.50,1.5']);
    });

    it('the rule sits clear of the band: the scale’s headroom keeps the strongest wind below it', () => {
        const band: SpreadBandPoint[] = [
            { f: 0, minKts: 20, maxKts: 40, pinnedKts: 30, level: 'split' },
            { f: 1, minKts: 20, maxKts: 40, pinnedKts: 30, level: 'split' },
        ];
        const paths = spreadBandPaths(band);
        const ys = [...paths.band[0].matchAll(/,([\d.]+)/g)].map((m) => Number(m[1]));
        expect(Math.min(...ys)).toBeGreaterThan(3); // the rule occupies 0…3
    });

    it('past BOTH reaches the wind’s sentence wins the note — so rain goes back on the row that says it is at its own time', () => {
        setup({ maxMs: 100 * HOUR, aheadMs: 50 * HOUR, windCoverageHours: 46, rainCoverageHours: 3.7 });
        expect(screen.getByTestId('route-scrub-note').textContent).toContain('Chart wind ends +46 h');
        expect(screen.getByTestId('route-scrub-unsynced').textContent).toBe('Chart rain: still at its own time');
        cleanup();
        // Between the two reaches the rain note has the slot to itself: said once, not twice.
        setup({ maxMs: 100 * HOUR, aheadMs: 10 * HOUR, windCoverageHours: 46, rainCoverageHours: 3.7 });
        expect(screen.getByTestId('route-scrub-note').textContent).toBe('Chart rain ends +3.7 h');
        expect(screen.queryByTestId('route-scrub-unsynced')).toBeNull();
    });

    it('a second short of the end is still the end: Play offers to start again instead of doing nothing', () => {
        const { props } = setup({ aheadMs: 20 * HOUR - 400 });
        expect(screen.getByTestId('route-scrub-play').getAttribute('aria-label')).toBe('Play again from now');
        fireEvent.click(screen.getByTestId('route-scrub-play'));
        expect(props.onAhead).toHaveBeenCalledWith(0);
    });
});

describe('phase 4: the sea has makers too', () => {
    it('credits the wave and current providers beside the wind models — everyone whose numbers are on the strip', () => {
        setup({
            modelProvider: 'ECMWF',
            spreadProviders: ['DWD', 'ECMWF', 'UK Met Office', 'JMA'],
            seaProviders: ['Météo-France', 'Open-Meteo'],
        });
        expect(screen.getByTestId('route-scrub-credit').textContent).toBe(
            'Forecast data: DWD, ECMWF, UK Met Office, JMA, Météo-France, Open-Meteo',
        );
    });

    it('names nobody twice, and nobody whose numbers are not on screen', () => {
        setup({ modelProvider: 'ECMWF', seaProviders: ['Météo-France', 'ECMWF'] });
        expect(screen.getByTestId('route-scrub-credit').textContent).toBe('Forecast data: ECMWF, Météo-France');
        cleanup();
        setup({ modelProvider: 'ECMWF', seaProviders: null });
        expect(screen.getByTestId('route-scrub-credit').textContent).toBe('Forecast data: ECMWF');
    });

    it('the credit may run to three lines on a phone — and is still never cut off', () => {
        setup({ seaProviders: ['Météo-France', 'Open-Meteo'] });
        expect(screen.getByTestId('route-scrub-credit').className).not.toMatch(
            /truncate|line-clamp|whitespace-nowrap|overflow-hidden/,
        );
    });
});
