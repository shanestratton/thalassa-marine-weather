/** Local visual QA only: no app store, network service, telemetry or yacht connection. */
import React, { useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../index.css';
import { HeadingGauge } from '../../components/nmea/gauges/HeadingGauge';
import { AttitudeGauge } from '../../components/nmea/gauges/AttitudeGauge';
import { RudderGauge } from '../../components/nmea/gauges/RudderGauge';
import { BarometerGauge } from '../../components/nmea/gauges/BarometerGauge';
import { SereneWindRose } from '../../components/nmea/gauges/SereneWindRose';
import { ShipsBellClock } from '../../components/nmea/gauges/ShipsBellClock';
import { SailPlanDiagram } from '../../components/nmea/gauges/SailPlanDiagram';
import { SailPartsDiagram } from '../../components/nmea/gauges/SailPartsDiagram';
import { POSITION_FONT_SIZE, WIND_CELL_STYLE, windHeroStyle } from '../../components/nmea/instrumentLayout';

function Fixture() {
    const [mode, setMode] = useState('light');
    useLayoutEffect(() => {
        document.documentElement.classList.toggle('display-light', mode === 'light');
    }, [mode]);
    return (
        <main className="min-h-screen bg-slate-950 p-4 text-white" data-mode={mode}>
            <nav className="mb-4 flex gap-2">
                {['light', 'dark', 'night'].map((name) => (
                    <button
                        className="rounded-lg border border-white/20 px-4 py-2"
                        key={name}
                        onClick={() => setMode(name)}
                    >
                        {name}
                    </button>
                ))}
            </nav>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {[
                    [
                        'Wind · port',
                        <SereneWindRose
                            className="w-full aspect-square"
                            gaugeKey="qa-port"
                            angle={315}
                            speed={18.2}
                            heading={40}
                        />,
                    ],
                    [
                        'Wind · starboard',
                        <SereneWindRose
                            className="w-full aspect-square"
                            gaugeKey="qa-stbd"
                            angle={45}
                            speed={12.4}
                            heading={40}
                        />,
                    ],
                    ['Heading', <HeadingGauge value={7} isLive />],
                    [
                        'Pressure · warning',
                        <BarometerGauge hpa={998} setHandHpa={1006} severity="warn" readout="998" />,
                    ],
                    ['Heel · port', <AttitudeGauge axis="heel" angle={-8.2} />],
                    ['Pitch · bow up', <AttitudeGauge axis="pitch" angle={4.5} />],
                    ['Rudder · starboard', <RudderGauge angle={18.3} />],
                    ['Clock', <ShipsBellClock hour={14} minute={30} second={15} zoneLabel="AEST" />],
                    [
                        'Wind · absent',
                        <SereneWindRose
                            className="w-full aspect-square"
                            gaugeKey="qa-absent"
                            angle={null}
                            speed={null}
                        />,
                    ],
                    [
                        'Wind · stale',
                        <SereneWindRose
                            className="w-full aspect-square"
                            gaugeKey="qa-stale"
                            angle={315}
                            speed={18.2}
                            isLive={false}
                        />,
                    ],
                    ['Heading · absent', <HeadingGauge value={null} isLive={false} />],
                    ['Rudder · absent', <RudderGauge angle={null} freshness="dead" />],
                    [
                        'Sail plan',
                        <SailPlanDiagram
                            className="w-full"
                            band="Running"
                            windAngle={150}
                            main="Full"
                            yankee="Full"
                            stay
                            prevent
                            runners
                        />,
                    ],
                    ['Sail parts', <SailPartsDiagram className="w-full" />],
                ].map(([label, face]) => (
                    <section
                        key={String(label)}
                        className="min-w-0 rounded-xl border border-white/10 bg-slate-900 p-3"
                        data-gauge={String(label)}
                    >
                        <h2 className="mb-2 text-center text-sm font-bold">{label}</h2>
                        {face}
                    </section>
                ))}
            </div>
            <div data-testid="pane-size-probe" className="mt-4" style={{ width: 360, maxWidth: '100%' }}>
                <div data-testid="wind-hero-size" style={windHeroStyle(280)} />
                <div data-testid="wind-cell-size" style={{ ...WIND_CELL_STYLE, height: 300 }} />
                <span data-testid="position-size" style={{ fontSize: POSITION_FONT_SIZE }}>
                    153° 04.567′ E
                </span>
            </div>
            {mode === 'night' && (
                <div className="pointer-events-none fixed inset-0" style={{ background: 'rgba(69, 10, 10, 0.25)' }} />
            )}
        </main>
    );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
