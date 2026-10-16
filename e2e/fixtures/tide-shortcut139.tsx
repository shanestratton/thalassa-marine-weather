/** Actual capped banner/control + production aboard source gate. No fixture
 * provider, rights, chart tie, navigation samples or network are supplied. */
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../index.css';
import type { TideShortcutView } from '../../services/routing/tideGatedPlanning';
if (!import.meta.env.DEV) throw Error('Development fixture only.');
document.documentElement.style.fontSize = '20.8px';
let calls = 0,
    reads = 0;
window.fetch = async () => {
    calls++;
    throw Error('No WAN is available in this aboard-only fixture.');
};
const { PassageBanner } = await import('../../components/map/PassageBanner');
const { prepareTideGatedSources } = await import('../../services/routing/tideGatedSources');
function Fixture() {
    const [enabled, setEnabled] = useState(false),
        [buffer, setBuffer] = useState(15),
        [review, setReview] = useState<TideShortcutView | null>(null),
        epoch = useRef(0);
    useEffect(() => {
        const generation = ++epoch.current,
            controller = new AbortController();
        if (!enabled) {
            setReview(null);
            return () => controller.abort();
        }
        setReview(null);
        reads++;
        void prepareTideGatedSources(
            {
                from: { lat: 0, lon: -0.0015 },
                to: { lat: 0, lon: 0.0015 },
                departureMs: Date.now(),
                speedKts: 6,
                requiredM: 2.5,
                uncertaintyMs: buffer * 60000,
                lifetimeKey: `browser-fixture-${generation}`,
            },
            {
                signal: controller.signal,
                assertCurrent: () => {
                    if (generation !== epoch.current) throw new DOMException('Fixture input retired.', 'AbortError');
                },
            },
        )
            .then((result) => {
                result.release();
                if (!controller.signal.aborted)
                    setReview({
                        kind: 'held',
                        reason:
                            result.kind === 'held'
                                ? result.reason
                                : 'Unexpected navigation source in informational fixture.',
                    });
            })
            .catch((error) => {
                if (!controller.signal.aborted)
                    setReview({ kind: 'held', reason: error instanceof Error ? error.message : 'Source unavailable.' });
            });
        return () => controller.abort();
    }, [enabled, buffer]);
    return (
        <main style={{ height: '100dvh', overflow: 'hidden', background: '#020617' }}>
            <PassageBanner
                passage={{
                    showPassage: true,
                    departure: { lat: 0, lon: -0.0015, name: 'Departure' },
                    arrival: { lat: 0, lon: 0.0015, name: 'Arrival' },
                    departureTime: null,
                    speed: 6,
                    routeAnalysis: { totalDistance: 1, estimatedDuration: 1 },
                    routeVerification: { status: 'unverified', geometryKey: 'fixture' },
                    routeActionsAvailable: false,
                    routeCaveats: Array.from(
                        { length: 24 },
                        (_, i) =>
                            `Reference ${i + 1}: retain the chart and original source disclosures in the existing internal scroll.`,
                    ),
                    isoResultRef: { current: null },
                    turnWaypointsRef: { current: [] },
                    setShowPassage: () => {},
                    clearRoute: () => {},
                    tideShortcutEnabled: enabled,
                    setTideShortcutEnabled: setEnabled,
                    tideArrivalBufferMinutes: buffer,
                    setTideArrivalBufferMinutes: setBuffer,
                    tideShortcutReview: review,
                }}
                isoProgress={null}
                embedded={false}
                isPinView={false}
                deviceMode="deck"
            />
        </main>
    );
}
(window as unknown as { __tide139: { calls: () => number; reads: () => number } }).__tide139 = {
    calls: () => calls,
    reads: () => reads,
};
createRoot(document.getElementById('root')!).render(<Fixture />);
