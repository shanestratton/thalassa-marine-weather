/** Generated public-coordinate fixture. Only the test's synthetic REST origin is allowed. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../index.css';
if (!import.meta.env.DEV) throw new Error('Development fixture only');
const { setAuthIdentityScope } = await import('../../services/authIdentityScope');
setAuthIdentityScope('10000000-0000-4000-8000-000000000001');
const [{ useSettingsStore }, { useFollowRouteStore }, { default: WeatherWatchSection }] = await Promise.all([
    import('../../stores/settingsStore'),
    import('../../stores/followRouteStore'),
    import('../../components/settings/WeatherWatchSection'),
]);
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
