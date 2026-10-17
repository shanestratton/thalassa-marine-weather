/** Synthetic phone consent/guest coverage UI only. No real account, receiver, provider or onward transport. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import '../../index.css';
import { PiFleetSharingSheet } from '../../components/settings/PiFleetSharingSection';
import type { PiFleetSession } from '../../services/ais/piFleetClient';
import { RadialHelmMenu } from '../../components/map/RadialHelmMenu';
import ObsCreditsRollup from '../../components/map/ObsCreditsRollup';
import ReceiverCoverageLayer from '../../components/map/ReceiverCoverageLayer';
import type { ReceiverCoverageStatus } from '../../services/ais/receiverCoverage';
import { SAT_IR_FULL_COVERAGE } from '../../components/map/satelliteImagery';
if (!import.meta.env.DEV) throw Error('Development-only synthetic140 fixture.');
declare global {
    interface Window {
        __receiverFixture: { bounds(): number[]; actions: string[] };
    }
}
function Fixture() {
    const phone = new URLSearchParams(location.search).get('view') === 'phone';
    const [on, setOn] = React.useState(false),
        [ready, setReady] = React.useState(false),
        [status, setStatus] = React.useState<ReceiverCoverageStatus>({
            state: 'off',
            partial: false,
            cells: 0,
            asOf: null,
        });
    const mapRef = React.useRef<mapboxgl.Map | null>(null),
        container = React.useRef<HTMLDivElement | null>(null),
        actions = React.useRef<string[]>([]);
    React.useEffect(() => {
        window.__receiverFixture = {
            actions: actions.current,
            bounds: () => {
                const r = container.current?.getBoundingClientRect();
                return [
                    r?.x ?? 0,
                    r?.y ?? 0,
                    r?.width ?? 0,
                    r?.height ?? 0,
                    document.documentElement.scrollWidth,
                    document.documentElement.scrollHeight,
                ];
            },
        };
        if (phone) return;
        const map = new mapboxgl.Map({
            container: container.current!,
            accessToken: 'pk.fixture-only-synthetic-map',
            center: [153, -27],
            zoom: 5,
            performanceMetricsCollection: false,
            style: {
                version: 8,
                sources: {},
                layers: [{ id: 'local-background', type: 'background', paint: { 'background-color': '#082f49' } }],
            },
        });
        mapRef.current = map;
        map.on('load', () => setReady(true));
        return () => {
            mapRef.current = null;
            map.remove();
        };
    }, [phone]);
    const session: PiFleetSession = {
        initial: {
            operatorConfigured: true,
            state: 'off',
            consent: null,
            lastLocalRevision: null,
            lastAcknowledgedAt: null,
        },
        vesselName: 'Synthetic 55-foot family yacht with a deliberately long review name',
        current: () => true,
        release: () => {},
        enable: async () => {
            actions.current.push('enable');
            return {
                operatorConfigured: true,
                state: 'listening',
                consent: null,
                lastLocalRevision: null,
                lastAcknowledgedAt: null,
            };
        },
        off: async () => {
            actions.current.push('off');
            return { localStopped: true, cloudWithdrawn: false };
        },
    };
    if (phone)
        return (
            <main className="fixed inset-0 overflow-hidden bg-slate-950">
                <PiFleetSharingSheet session={session} onClose={() => actions.current.push('close')} />
            </main>
        );
    return (
        <main data-testid="coverage-frame" className="fixed inset-0 isolate overflow-hidden bg-slate-950 text-white">
            <div ref={container} className="thalassa-chart-map" style={{ position: 'absolute', inset: 0 }} />
            <RadialHelmMenu
                activeLayers={new Set()}
                toggleLayer={() => {}}
                selectInGroup={() => {}}
                tacticalState={{ receiverCoverageVisible: on, onToggleReceiverCoverage: () => setOn((v) => !v) }}
            />
            {on && <ReceiverCoverageLayer mapRef={mapRef} mapReady={ready} active onStatus={setStatus} />}
            <ObsCreditsRollup
                rain={null}
                wind={null}
                cmems={[]}
                lightning={false}
                satellite={{
                    status: 'off',
                    frameTimeMs: null,
                    frameCount: 0,
                    coverage: SAT_IR_FULL_COVERAGE,
                    playing: false,
                    following: false,
                }}
                ais={false}
                receiverCoverage={on ? status : undefined}
                onToggleSatellite={() => {}}
            />
        </main>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
