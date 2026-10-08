/**
 * Settings → Preferences, smoke builds only: start and stop the fictional
 * crossing target for the 125-11 locked-phone + Focus test. Reached only
 * through ./debugAisInjectorGate.ts; never in a release build.
 */
import React from 'react';
import { Row, Section } from './SettingsPrimitives';
import { debugAisInjectorRunning, startDebugCrossing, stopDebugAisInjector } from '../../services/debug/aisInjector';

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
                            setStatus('Stopped.');
                        }}
                    >
                        Stop
                    </button>
                </div>
            </Row>
        </Section>
    );
};
