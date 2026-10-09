/**
 * Settings → Preferences, smoke builds only: start and stop the fictional
 * crossing target for the 125-11 locked-phone + Focus test, (125-02) a
 * fictional AIS-SART in test or active mode, and (125-01b) an anchored pass:
 * a ship under way 0.05 NM off while we are stopped. (126-02a) The under-way
 * alarms: a fictional off-route excursion (0.4 NM off a line she was on) and
 * a fictional shoal reading (0.3 m under the keel), each 5 minutes at 4 kn.
 * Reached only through ./debugAisInjectorGate.ts; never in a release build.
 */
import React from 'react';
import { Row, Section } from './SettingsPrimitives';
import {
    debugAisInjectorRunning,
    startDebugAnchorPass,
    startDebugCrossing,
    startDebugSart,
    stopDebugAisInjector,
} from '../../services/debug/aisInjector';
import { setDebugUnderway } from '../../services/underway/UnderwayAlarmWatch';

/** 126-02a: five minutes of a fictional excursion or shoal reading, through the real watch. */
function startUnderway(kind: 'off-route' | 'shoal'): string {
    const now = Date.now();
    setDebugUnderway({ kind, startedAt: now, until: now + 5 * 60_000 });
    return kind === 'off-route'
        ? 'Fictional route for 5 min: on it 15 s, then 0.4 NM off. It must sound about 25 s in.'
        : 'Fictional sounder for 5 min: 0.3 m under the keel at 4 kn. It must sound within 10 s.';
}

export const DebugAisInjectorSection: React.FC = () => {
    const [status, setStatus] = React.useState(() =>
        debugAisInjectorRunning() ? 'A fictional target is running.' : 'Smoke builds only. Arm the shield first.',
    );
    return (
        <Section title="Debug: AIS injector">
            <Row>
                <div className="flex-1 min-w-0">
                    <p className="text-sm text-white font-medium">Fictional crossing target</p>
                    <p className="text-xs text-gray-400" role="status">
                        {status}
                    </p>
                </div>
                <div className="flex shrink-0 gap-2">
                    <button
                        type="button"
                        className="min-h-11 rounded-lg border border-white/10 px-3 text-xs font-bold text-white"
                        onClick={() => setStatus(startDebugCrossing())}
                    >
                        Start
                    </button>
                    <button
                        type="button"
                        className="min-h-11 rounded-lg border border-white/10 px-3 text-xs font-bold text-white"
                        onClick={() => {
                            stopDebugAisInjector();
                            setDebugUnderway(null);
                            setStatus('Stopped.');
                        }}
                    >
                        Stop
                    </button>
                </div>
            </Row>
            <Row>
                <div className="flex-1 min-w-0">
                    <p className="text-sm text-white font-medium">Anchored pass</p>
                    <p className="text-xs text-gray-400">Anchor watch on: it must sound. Off: quiet.</p>
                </div>
                <div className="flex shrink-0 gap-2">
                    <button
                        type="button"
                        className="min-h-11 rounded-lg border border-white/10 px-3 text-xs font-bold text-white"
                        aria-label="Start the anchored pass"
                        onClick={() => setStatus(startDebugAnchorPass())}
                    >
                        Start
                    </button>
                </div>
            </Row>
            <Row>
                <div className="flex-1 min-w-0">
                    <p className="text-sm text-white font-medium">Under-way alarms</p>
                    <p className="text-xs text-gray-400">Off route and shoal water, each 5 min. Stop ends both.</p>
                </div>
                <div className="flex shrink-0 gap-2">
                    <button
                        type="button"
                        className="min-h-11 rounded-lg border border-white/10 px-3 text-xs font-bold text-white"
                        aria-label="Start the fictional off-route excursion"
                        onClick={() => setStatus(startUnderway('off-route'))}
                    >
                        Off route
                    </button>
                    <button
                        type="button"
                        className="min-h-11 rounded-lg border border-white/10 px-3 text-xs font-bold text-white"
                        aria-label="Start the fictional shoal reading"
                        onClick={() => setStatus(startUnderway('shoal'))}
                    >
                        Shoal
                    </button>
                </div>
            </Row>
            <Row>
                <div className="flex-1 min-w-0">
                    <p className="text-sm text-white font-medium">Fictional AIS-SART</p>
                    <p className="text-xs text-gray-400">Test first, then Active: the switch must sound.</p>
                </div>
                <div className="flex shrink-0 gap-2">
                    <button
                        type="button"
                        className="min-h-11 rounded-lg border border-white/10 px-3 text-xs font-bold text-white"
                        onClick={() => setStatus(startDebugSart('test'))}
                    >
                        Test
                    </button>
                    <button
                        type="button"
                        className="min-h-11 rounded-lg border border-white/10 px-3 text-xs font-bold text-white"
                        onClick={() => setStatus(startDebugSart('active'))}
                    >
                        Active
                    </button>
                </div>
            </Row>
        </Section>
    );
};
