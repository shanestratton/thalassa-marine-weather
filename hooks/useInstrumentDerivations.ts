import { useEffect, useState } from 'react';
import { useSettingsStore } from '../stores/settingsStore';
import { resolveEffectiveVessel } from '../utils/defaultVessel';
import { useRoutingPolar } from './useRoutingPolar';
import type { NmeaStoreState } from '../services/NmeaStore';
import { usableReading } from '../services/instruments/measurements';
import { measuredCurrent } from '../services/instruments/measuredCurrent';
import { sailingPerformance } from '../services/instruments/performance';
import { confirmUnderSail, resetUnderSailForFeed, useUnderSailConfirmation } from '../services/instruments/underSail';
export function useInstrumentDerivations(state: NmeaStoreState, clock?: number) {
    const [tick, setTick] = useState(Date.now);
    useEffect(() => {
        if (clock !== undefined) return;
        const id = setInterval(() => setTick(Date.now()), 1000);
        return () => clearInterval(id);
    }, [clock]);
    const now = clock ?? tick;
    const raw = useSettingsStore((store) => store.settings.vessel);
    const vessel = resolveEffectiveVessel(raw);
    const polar = useRoutingPolar(vessel);
    const evidence = state.instrumentEvidence;
    const confirmationIdentity = evidence ? `${evidence.identity}:${evidence.via}` : undefined;
    const confirmed = useUnderSailConfirmation(confirmationIdentity);
    const rpm = evidence?.readings.rpm;
    const engineRunning = usableReading(rpm, 'rpm', now, 0, 30000) && rpm.value > 0;
    useEffect(() => resetUnderSailForFeed(confirmationIdentity, engineRunning), [confirmationIdentity, engineRunning]);
    return {
        now,
        vessel,
        polar,
        evidence,
        engineRunning,
        confirmed,
        confirmSail: () => confirmUnderSail(confirmationIdentity ?? null),
        current: measuredCurrent(evidence, now),
        performance: sailingPerformance({
            evidence,
            polar,
            vessel,
            propulsion: engineRunning ? 'engine' : confirmed ? 'sail' : 'unknown',
            now,
        }),
    };
}
