import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import '../../index.css';
if (!import.meta.env.DEV) throw new Error('Development fixture only');
const { setAuthIdentityScope, getAuthIdentityScope } = await import('../../services/authIdentityScope');
const [{ useSettingsStore, awaitSettingsLoaded }, { default: Watch }, { useAuthStore }] = await Promise.all([
    import('../../stores/settingsStore'),
    import('../../components/vessel/OverdueWatchSection'),
    import('../../stores/authStore'),
]);
if (!useAuthStore.getState().authChecked)
    await new Promise<void>((resolve) => {
        const stop = useAuthStore.subscribe((s) => {
            if (s.authChecked) {
                stop();
                resolve();
            }
        });
    });
setAuthIdentityScope('10000000-0000-4000-8000-000000000001');
await awaitSettingsLoaded();
useSettingsStore.setState({
    activeVesselId: '20000000-0000-4000-8000-000000000001',
    settings: { ...useSettingsStore.getState().settings, satelliteMode: false },
});
Object.assign(window, { __overdueAccountSwap: () => setAuthIdentityScope('10000000-0000-4000-8000-000000000099') });
const binding = {
    key: getAuthIdentityScope().key,
    generation: getAuthIdentityScope().generation,
    boatId: useSettingsStore.getState().activeVesselId,
};
function Fixture() {
    const [plan, setPlan] = useState({
        vesselLabel: 'Private fixture yacht',
        from: 'Harbour',
        to: 'Anchorage',
        departureAt: Date.now() - 3600000,
        etaAt: null,
        overdueAt: Date.now() + 3600000,
        persons: 2,
    });
    return (
        <main className="min-h-screen bg-slate-950 text-slate-200 p-3 max-w-xl mx-auto">
            <button
                type="button"
                className="min-h-11 px-3"
                onClick={() => setPlan((p) => ({ ...p, overdueAt: p.overdueAt + 3600000 }))}
            >
                Edit planned deadline
            </button>
            <Watch plan={plan} binding={binding} />
        </main>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
