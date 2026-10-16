/** Development-only equipment UI; synthetic account and RAM-only save, no boat/provider connection. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../index.css';
import MarineRadarEquipmentSection from '../../components/settings/MarineRadarEquipmentSection';
import { setAuthIdentityScope } from '../../services/authIdentityScope';
import { useSettingsStore, awaitSettingsLoaded } from '../../stores/settingsStore';
import type { MarineRadarEquipment } from '../../types/marineRadar';
if (!import.meta.env.DEV) throw Error('Development fixture only');
function Fixture() {
    const [value, setValue] = React.useState<MarineRadarEquipment | null>(null);
    return (
        <main className="fixed inset-0 overflow-y-auto bg-slate-950 p-4 text-white" data-testid="radar-profile-frame">
            <h1 className="mb-4 text-lg font-bold">Vessel equipment</h1>
            <div className="rounded-2xl border border-white/15">
                <MarineRadarEquipmentSection
                    value={value}
                    vesselId="00000000-0000-4000-8000-000000000138"
                    onSave={setValue}
                />
            </div>
            <p className="mt-4 break-words text-xs" data-testid="saved-equipment">
                {JSON.stringify(value)}
            </p>
        </main>
    );
}
async function mount() {
    setAuthIdentityScope('00000000-0000-4000-8000-000000000137');
    await awaitSettingsLoaded();
    useSettingsStore.setState({ activeVesselId: '00000000-0000-4000-8000-000000000138' });
    createRoot(document.getElementById('root')!).render(<Fixture />);
}
void mount();
