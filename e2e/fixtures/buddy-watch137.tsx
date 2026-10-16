/** Generated public-water AIS; actual Targets, lazy sheet and RPC client. */
import { createRoot } from 'react-dom/client';
import '../../index.css';
if (!import.meta.env.DEV) throw new Error('Development fixture only');
const { setAuthIdentityScope } = await import('../../services/authIdentityScope');
setAuthIdentityScope('10000000-0000-4000-8000-000000000001');
const [{ useSettingsStore }, { AisStore }, { AisTargetsSheet }] = await Promise.all([
    import('../../stores/settingsStore'),
    import('../../services/AisStore'),
    import('../../components/map/AisTargetsSheet'),
]);
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
