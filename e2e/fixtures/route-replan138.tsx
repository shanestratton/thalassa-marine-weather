import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../index.css';
if (!import.meta.env.DEV) throw Error('Development fixture only');
class FixtureStorage implements Storage {
    private values = new Map<string, string>();
    get length() {
        return this.values.size;
    }
    clear() {
        this.values.clear();
    }
    key(i: number) {
        return [...this.values.keys()][i] ?? null;
    }
    getItem(key: string) {
        return this.values.get(String(key)) ?? null;
    }
    setItem(key: string, value: string) {
        this.values.set(String(key), String(value));
    }
    removeItem(key: string) {
        this.values.delete(String(key));
    }
}
Object.defineProperty(window, 'localStorage', { configurable: true, value: new FixtureStorage() });
Object.defineProperty(window, 'sessionStorage', { configurable: true, value: new FixtureStorage() });
document.documentElement.style.fontSize = '20.8px';
const [{ PassageBanner }, { replan138Fixture }, { setRouteReplan }, { useFollowRouteStore }] = await Promise.all([
    import('../../components/map/PassageBanner'),
    import('../../tests/helpers/replan138Fixture'),
    import('../../services/routing/routeReplanSession'),
    import('../../stores/followRouteStore'),
]);
const fixture = replan138Fixture();
useFollowRouteStore.setState({
    isFollowing: true,
    voyageId: 'fictional-original',
    startedAt: 'fictional-start',
    voyagePlan: fixture.base.original,
    routeCoords: fixture.base.oldCoords,
});
setRouteReplan({
    phase: 'computing',
    base: fixture.base,
    candidate: null,
    message: 'Checking the proposed line. The original is still followed.',
});
Object.assign(window, {
    __routeReplan138: {
        ready: () =>
            setRouteReplan({
                phase: 'ready',
                base: fixture.base,
                candidate: fixture.candidate,
                message: 'Review both lines before accepting.',
            }),
        followedId: () => useFollowRouteStore.getState().voyageId,
    },
});
function Fixture() {
    const [show, setShow] = React.useState(true);
    React.useEffect(() => {
        document.body.dataset.ready = 'true';
    }, []);
    return (
        <main className="relative h-dvh overflow-hidden bg-slate-950 text-white">
            {!show && <p>Comparison closed. Original route retained.</p>}
            <PassageBanner
                passage={{
                    showPassage: show,
                    departure: { lat: 0, lon: 150, name: 'Current position' },
                    arrival: { lat: 0, lon: 150.02, name: fixture.base.original.destination },
                    routeAnalysis: { totalDistance: 1.2, estimatedDuration: 1 },
                    routeVerification: { status: 'verified', geometryKey: fixture.candidate.geometryKey },
                    routeActionsAvailable: true,
                    departureTime: fixture.base.departureTime,
                    setShowPassage: setShow,
                    clearRoute: () => setShow(false),
                    isoResultRef: { current: fixture.candidate.result },
                    turnWaypointsRef: { current: [] },
                    speed: 6,
                }}
                isoProgress={null}
                embedded={false}
                isPinView={false}
                deviceMode="deck"
            />
        </main>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
