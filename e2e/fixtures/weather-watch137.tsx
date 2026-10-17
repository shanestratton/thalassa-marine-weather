/** Generated public-coordinate fixture. Only the test's synthetic REST origin is allowed. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../index.css';
if (!import.meta.env.DEV) throw new Error('Development fixture only');
const { setAuthIdentityScope } = await import('../../services/authIdentityScope');
const [
    { useSettingsStore, awaitSettingsLoaded },
    { useFollowRouteStore },
    { default: WeatherWatchSection },
    { useAuthStore },
] = await Promise.all([
    import('../../stores/settingsStore'),
    import('../../stores/followRouteStore'),
    import('../../components/settings/WeatherWatchSection'),
    import('../../stores/authStore'),
]);
// Finish the real empty-session bootstrap before installing the fictional
// owner; a late anonymous completion must not retire the fixture's scope.
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
    settings: {
        ...useSettingsStore.getState().settings,
        satelliteMode: false,
        savedLocations: ['Generated public ocean spot'],
        savedLocationCoords: { 'Generated public ocean spot': { lat: 0, lon: 179.5 } },
    },
});
useFollowRouteStore.setState({
    isFollowing: true,
    routeCoords: [
        { lat: 0, lon: 179 },
        { lat: 0.1, lon: 179.5 },
        { lat: 0.2, lon: -179.9 },
    ],
});
createRoot(document.getElementById('root')!).render(
    <main className="min-h-screen bg-slate-950 p-3 text-white">
        <WeatherWatchSection />
    </main>,
);
