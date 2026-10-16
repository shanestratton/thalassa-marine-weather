import React from 'react';
import type { MarineRadarEquipment } from '../../types/marineRadar';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
} from '../../services/authIdentityScope';
import { radarEquipmentLabel } from '../../services/radar/radarEquipment';
import { useSettingsStore } from '../../stores/settingsStore';
import { RowChevron } from './SettingsPrimitives';
const Sheet = React.lazy(() => import('./MarineRadarEquipmentSheet'));
export default function MarineRadarEquipmentSection({
    value,
    vesselId,
    onSave,
}: {
    value: unknown;
    vesselId: string | null;
    onSave: (value: MarineRadarEquipment | null) => void;
}) {
    const life = React.useRef(0),
        [session, setSession] = React.useState<{ isCurrent: () => boolean } | null>(null);
    React.useEffect(() => {
        const invalidate = () => {
            life.current++;
        };
        const retire = () => {
            life.current++;
            setSession(null);
        };
        const auth = subscribeAuthIdentityScope(retire);
        // The real fleet store emits synchronously, so A → B → A retires an open editor.
        const store =
            typeof useSettingsStore.subscribe === 'function'
                ? useSettingsStore.subscribe((next, previous) => {
                      if (next.activeVesselId !== previous.activeVesselId) retire();
                  })
                : () => {};
        return () => {
            invalidate();
            auth();
            store();
        };
    }, []);
    React.useEffect(() => {
        life.current++;
        setSession(null);
    }, [vesselId]);
    return (
        <>
            <button
                type="button"
                className="flex min-h-14 w-full items-center justify-between gap-3 px-4 py-3 text-left"
                onClick={() => {
                    const epoch = life.current,
                        scope = getAuthIdentityScope();
                    setSession({
                        isCurrent: () =>
                            life.current === epoch &&
                            isAuthIdentityScopeCurrent(scope) &&
                            (typeof useSettingsStore.getState === 'function'
                                ? (useSettingsStore.getState().activeVesselId ?? null)
                                : null) === vesselId,
                    });
                }}
            >
                <span className="min-w-0">
                    <span className="block text-sm font-bold text-white">Marine radar</span>
                    <span className="block break-words text-xs text-gray-400">{radarEquipmentLabel(value)}</span>
                </span>
                <RowChevron />
            </button>
            {session && (
                <React.Suspense
                    fallback={
                        <p role="status" className="p-4 text-xs">
                            Opening radar equipment…
                        </p>
                    }
                >
                    <Sheet
                        value={value}
                        canDetect={vesselId !== null}
                        isCurrent={session.isCurrent}
                        onClose={() => setSession(null)}
                        onSave={(next) => {
                            if (session.isCurrent()) onSave(next);
                            setSession(null);
                        }}
                    />
                </React.Suspense>
            )}
        </>
    );
}
