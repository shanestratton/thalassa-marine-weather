/** Real controller, GpsService, Supabase client, layer/menu/sheets; fictional API/GPS only. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import '../../index.css';
import { RadialHelmMenu } from '../../components/map/RadialHelmMenu';
import ObsCreditsRollup from '../../components/map/ObsCreditsRollup';
import { SAT_IR_FULL_COVERAGE } from '../../components/map/satelliteImagery';
import BoatPresenceSurface, { type BoatPresenceStatus } from '../../components/map/presence/BoatPresenceSurface';
import { boatPresence } from '../../services/presence/boatPresence';
import { setAuthIdentityScope } from '../../services/authIdentityScope';
import { awaitSettingsLoaded, useSettingsStore } from '../../stores/settingsStore';
import { GpsService } from '../../services/GpsService';
if (!import.meta.env.DEV) throw Error('Fictional development fixture only');
const owner = '00000000-0000-4000-8000-000000000001',
    vessel = '00000000-0000-4000-8000-000000000002';
setAuthIdentityScope(owner);
await awaitSettingsLoaded();
useSettingsStore.setState({
    activeVesselId: vessel,
    vesselFleetStatus: 'saved',
    vesselFleet: [
        {
            id: vessel,
            owner_id: owner,
            profile: {
                name: 'Fictional yacht',
                type: 'sail',
                length: 35,
                beam: 12,
                draft: 5,
                displacement: 12000,
                maxWaveHeight: 5,
                cruisingSpeed: 5,
            },
            revision: 1,
            updated_at: '2026-10-17T00:00:00Z',
            is_active: true,
            mmsiClaimed: null,
            releasedAt: null,
            releaseReason: null,
        },
    ],
});
declare global {
    interface Window {
        __presenceGpsClock?: { raw: number; milliseconds: number; normalized: boolean };
        __presenceFixture: {
            ready: () => boolean;
            gps: () => number | null;
            tick: () => Promise<void>;
            identity: () => void;
            satellite: (on: boolean) => void;
            foreground: (on: boolean) => void;
            session: () => { viewing: boolean; publishing: boolean };
            expire: () => void;
            diagnostic: () => unknown;
        };
    }
}
function Fixture() {
    const frame = React.useRef<HTMLDivElement>(null),
        map = React.useRef<mapboxgl.Map | null>(null);
    const [ready, setReady] = React.useState(false),
        [visible, setVisible] = React.useState(false),
        [open, setOpen] = React.useState(false),
        [active, setActive] = React.useState(true),
        [status, setStatus] = React.useState<BoatPresenceStatus | null>(null);
    const close = React.useCallback(() => setOpen(false), []);
    React.useEffect(() => {
        mapboxgl.accessToken = 'pk.synthetic-boats';
        const m = new mapboxgl.Map({
            container: frame.current!,
            style: {
                version: 8,
                sources: {},
                layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#123044' } }],
            },
            center: [0.025, 0.025],
            zoom: 10,
            attributionControl: false,
            fadeDuration: 0,
        });
        map.current = m;
        m.on('load', () => setReady(true));
        // Represents the app's existing foreground ownship watch. Presence
        // itself only reads its retained ORIGINAL timestamp and adds no watch.
        const stop = GpsService.watchPosition(() => {}, { ensureRunning: true });
        window.__presenceFixture = {
            ready: () => m.loaded(),
            gps: () => GpsService.getLastKnownPosition()?.timestamp ?? null,
            tick: () => boatPresence.tick(),
            identity: () => setAuthIdentityScope('00000000-0000-4000-8000-000000000099'),
            satellite: (on) => useSettingsStore.setState((s) => ({ settings: { ...s.settings, satelliteMode: on } })),
            foreground: setActive,
            session: () => ({
                viewing: boatPresence.snapshot().viewing,
                publishing: boatPresence.snapshot().publishing,
            }),
            expire: boatPresence.expire,
            diagnostic: () => ({
                presence: boatPresence.snapshot(),
                gps: GpsService.getLastKnownPosition(),
                now: Date.now(),
                active: useSettingsStore.getState().activeVesselId,
                fleet: useSettingsStore.getState().vesselFleet.map((v) => ({ id: v.id, owner: v.owner_id })),
            }),
        };
        return () => {
            stop();
            m.remove();
        };
    }, []);
    return (
        <main className="fixed inset-0 overflow-hidden bg-slate-950 text-white">
            <div ref={frame} className="thalassa-chart-map" style={{ position: 'absolute', inset: 0 }} />
            <RadialHelmMenu
                activeLayers={new Set()}
                toggleLayer={() => {}}
                selectInGroup={() => {}}
                tacticalState={{
                    boatPresenceVisible: visible,
                    onToggleBoatPresence: () => setVisible((v) => !v),
                    onOpenBoatPresence: () => setOpen(true),
                    onToggleAis: () => {},
                    onToggleLightning: () => {},
                    onToggleCyclones: () => {},
                    onToggleSquall: () => {},
                    onToggleWeatherInspect: () => {},
                }}
            />
            {active && (
                <BoatPresenceSurface
                    map={map.current}
                    mapReady={ready}
                    viewing={visible}
                    onViewingChange={setVisible}
                    controlsOpen={open}
                    onCloseControls={close}
                    onStatus={setStatus}
                />
            )}
            <ObsCreditsRollup
                rain={null}
                wind={null}
                cmems={[]}
                lightning={false}
                ais={false}
                satellite={{
                    status: 'off',
                    frameTimeMs: null,
                    frameCount: 0,
                    coverage: SAT_IR_FULL_COVERAGE,
                    playing: false,
                    following: false,
                }}
                onToggleSatellite={() => {}}
                boatPresence={status}
                onOpenBoatPresence={() => setOpen(true)}
            />
        </main>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
