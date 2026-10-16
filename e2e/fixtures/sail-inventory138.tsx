import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../index.css';
if (!import.meta.env.DEV) throw Error('Development fixture only');
class FixtureStorage implements Storage {
    private values = new Map<string, string>();
    get length() {
        return this.values.size;
    }
    clear() {
        this.values.clear();
    }
    key(i: number) {
        return [...this.values.keys()][i] ?? null;
    }
    getItem(key: string) {
        return this.values.get(String(key)) ?? null;
    }
    setItem(key: string, value: string) {
        this.values.set(String(key), String(value));
    }
    removeItem(key: string) {
        this.values.delete(String(key));
    }
}
Object.defineProperty(window, 'localStorage', { configurable: true, value: new FixtureStorage() });
Object.defineProperty(window, 'sessionStorage', { configurable: true, value: new FixtureStorage() });
document.documentElement.style.fontSize = '20.8px';
const [{ VesselTab }, { useSettingsStore, awaitSettingsLoaded }, { setAuthIdentityScope }, { sailInventoryFixture }] =
    await Promise.all([
        import('../../components/settings/VesselTab'),
        import('../../stores/settingsStore'),
        import('../../services/authIdentityScope'),
        import('../../tests/helpers/sailInventoryFixture'),
    ]);
await awaitSettingsLoaded();
setAuthIdentityScope(null);
const original = useSettingsStore.getState().settings;
const switchBoat = (id: 1 | 2) =>
    useSettingsStore.setState({
        activeVesselId: `synthetic-sail-${id}`,
        settings: {
            ...original,
            vessel: {
                name:
                    id === 1 ? 'Synthetic vessel with a deliberately long profile name' : 'Synthetic alternate vessel',
                type: 'sail',
                length: 30,
                beam: 10,
                draft: 5,
                displacement: 3000,
                maxWaveHeight: 0,
                cruisingSpeed: 6,
                ...(id === 1 ? { sailInventory: sailInventoryFixture() } : {}),
            },
        },
    });
switchBoat(1);
Object.assign(window, {
    __sailInventory138: {
        switchBoat: () => switchBoat(2),
        switchAccount: () => {
            setAuthIdentityScope('fictional-sail-other-account');
            switchBoat(2);
        },
        inventory: () => useSettingsStore.getState().settings.vessel?.sailInventory,
    },
});
function Fixture() {
    const settings = useSettingsStore((state) => state.settings);
    React.useEffect(() => {
        document.body.dataset.ready = 'true';
    }, []);
    return (
        <div className="h-dvh overflow-y-auto bg-slate-950 text-white">
            <VesselTab
                settings={settings}
                onSave={(patch) =>
                    useSettingsStore.setState((state) => ({ settings: { ...state.settings, ...patch } }))
                }
            />
        </div>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
