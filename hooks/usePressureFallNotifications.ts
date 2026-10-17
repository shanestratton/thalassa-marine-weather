import { useEffect, useRef, useState } from 'react';
import { useBarometerSource } from './useBarometerSource';
import { marineTendency } from '../utils/barometerTendency';
import { PressureFallWatch } from '../utils/pressureFallWatch';
import { notifyPressureFall } from '../services/PressureNotificationService';
import * as barometer from '../services/native/barometer';

/** Mounted with the app's notification manager, independent of any open sheet. */
export function usePressureFallNotifications(scopeKey: string, onNotify: (message: string) => void): void {
    const source = useBarometerSource(true);
    const [minute, setMinute] = useState(0);
    const watch = useRef(new PressureFallWatch());
    useEffect(() => {
        void barometer.startLogging();
        const timer = setInterval(() => setMinute((n) => n + 1), 30_000);
        return () => clearInterval(timer);
    }, []);
    useEffect(() => {
        // A suspended/backgrounded app does not claim to keep a pressure watch.
        const now = Date.now();
        if (typeof document !== 'undefined' && document.hidden) {
            watch.current.evaluate(null, null, now, scopeKey + ':' + source.source);
            return;
        }
        const reading = marineTendency(source.samples, now);
        if (!watch.current.evaluate(reading, source.latest?.t ?? null, now, scopeKey + ':' + source.source)) return;
        const body = reading!.read + ' ' + (reading!.diurnal?.reason ?? 'Raw pressure change.');
        onNotify('Pressure falling quickly. ' + body);
        void notifyPressureFall(body);
    }, [source, minute, scopeKey, onNotify]);
}
