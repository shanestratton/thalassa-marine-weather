/** Generated public-water AIS; actual Targets, lazy sheet and RPC client. */
import { createRoot } from 'react-dom/client';
import '../../index.css';
if (!import.meta.env.DEV) throw new Error('Development fixture only');
const { setAuthIdentityScope } = await import('../../services/authIdentityScope');
const [{ useSettingsStore, awaitSettingsLoaded }, { AisStore }, { AisTargetsSheet }, { useAuthStore }] =
    await Promise.all([
        import('../../stores/settingsStore'),
        import('../../services/AisStore'),
        import('../../components/map/AisTargetsSheet'),
        import('../../stores/authStore'),
    ]);
if (!useAuthStore.getState().authChecked)
    await new Promise<void>((resolve) => {
        const stop = useAuthStore.subscribe((state) => {
            if (state.authChecked) {
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
AisStore.update({
    mmsi: 234567891,
    name: 'Generated public vessel',
    lat: 0,
    lon: 179.9,
    sog: 0,
    lastUpdated: Date.now(),
});
createRoot(document.getElementById('root')!).render(
    <main className="bg-slate-950 text-white">
        <AisTargetsSheet onClose={() => {}} onSelect={() => {}} />
    </main>,
);
