import '../../services/shoreConsentLink';
import './shore-diagnostic137';
import { createRoot } from 'react-dom/client';
import '../../index.css';
if (!import.meta.env.DEV) throw new Error('Development fixture only');
const { setAuthIdentityScope } = await import('../../services/authIdentityScope');
const [
    { useSettingsStore, awaitSettingsLoaded },
    { default: Contacts },
    { ShoreConsentHost: Consent },
    { useAuthStore },
] = await Promise.all([
    import('../../stores/settingsStore'),
    import('../../components/settings/ShoreContactsSection'),
    import('../../components/anchor-watch/ShoreConsentHost'),
    import('../../stores/authStore'),
]);
// Finish the real empty Auth/local-settings bootstrap before installing the
// generated test account. Never race a late anonymous boot completion.
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
Object.assign(window, { __shoreAccountSwap: () => setAuthIdentityScope('10000000-0000-4000-8000-000000000002') });
createRoot(document.getElementById('root')!).render(
    <main className="bg-slate-950 text-white min-h-screen p-4 max-w-xl mx-auto">
        <Contacts />
        <Consent />
    </main>,
);
