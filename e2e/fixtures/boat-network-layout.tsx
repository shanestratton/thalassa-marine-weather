import React from 'react';
import { createRoot } from 'react-dom/client';
import { BoatHardwareIntegrations } from '../../components/vessel/BoatHardwareIntegrations';
import { PageHeader } from '../../components/ui/PageHeader';
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/settingsStore';
import '../../index.css';

const params = new URLSearchParams(location.search);
const pane = params.get('pane') === 'true';
const mode = params.get('mode') === 'light' ? 'light' : 'dark';
document.documentElement.classList.toggle('display-light', mode === 'light');

// Fresh browser contexts provide empty local storage. Keep the real settings
// subscription and Pi panel, but every settings save stays in this fixture.
// No app bootstrap, account, discovery, or physical boat is configured.
useSettingsStore.setState({
    settings: { ...DEFAULT_SETTINGS, piCacheEnabled: false, piCacheHost: '' },
    updateSettings: (patch) => {
        useSettingsStore.setState((state) => ({ settings: { ...state.settings, ...patch } }));
    },
});

function Fixture() {
    return (
        <main className="flex h-dvh w-full overflow-hidden bg-slate-950 text-white" data-mode={mode}>
            {pane && <aside className="h-full w-1/2 shrink-0 bg-slate-900 p-4 text-slate-300">Other tablet pane</aside>}
            <section
                className={`flex h-full min-h-0 min-w-0 flex-col ${pane ? 'w-1/2' : 'w-full'}`}
                data-testid="boat-network-pane"
                data-split-pane={pane ? 'vessel' : undefined}
            >
                <div className="shrink-0" data-testid="boat-network-header">
                    <PageHeader title="Boat Network" subtitle="Ship's Office" onBack={() => {}} />
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-32" data-testid="boat-network-scroll">
                    <div className="mb-3 rounded-2xl border border-white/6 bg-white/3 p-4">
                        <p className="text-sm font-bold">Boat Network</p>
                        <p className="mt-1 text-xs text-slate-300">Pi, instruments &amp; weather cache</p>
                    </div>
                    <BoatHardwareIntegrations />
                    <div className="rounded-2xl border border-white/6 bg-white/3 p-4">
                        <p className="text-sm font-bold">Charts on this phone</p>
                        <p className="mt-1 text-xs text-slate-300">No charts on this phone yet.</p>
                    </div>
                </div>
            </section>
        </main>
    );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
