import { useSyncExternalStore } from 'react';
import { authScopedStorageKey, subscribeAuthIdentityScope } from '../authIdentityScope';
export const INSTRUMENT_SECTIONS = [
    'Clock',
    'Watch',
    'Wind',
    'Barometer',
    'Position',
    'Speed',
    'Performance',
    'Current',
    'Depth',
    'Sea temp',
    'Heading',
    'Helm',
    'Engine',
] as const;
export type InstrumentSection = (typeof INSTRUMENT_SECTIONS)[number];
export interface InstrumentPanelPreferences {
    hidden: InstrumentSection[];
    performanceHud: boolean;
    laylines: boolean;
}
const defaults = (): InstrumentPanelPreferences => ({ hidden: [], performanceHud: false, laylines: true });
const key = () => authScopedStorageKey('thalassa_instrument_panel_v1');
const listeners = new Set<() => void>();
function read(): InstrumentPanelPreferences {
    try {
        const raw = JSON.parse(localStorage.getItem(key()) ?? 'null');
        return {
            hidden: INSTRUMENT_SECTIONS.filter((id) => Array.isArray(raw?.hidden) && raw.hidden.includes(id)),
            performanceHud: raw?.performanceHud === true,
            laylines: raw?.laylines !== false,
        };
    } catch {
        return defaults();
    }
}
let value = read();
const emit = () => listeners.forEach((listener) => listener());
subscribeAuthIdentityScope(() => {
    value = read();
    emit();
});
if (typeof window !== 'undefined')
    window.addEventListener('storage', (event) => {
        if (event.key === key() || event.key === null) {
            value = read();
            emit();
        }
    });
export const getInstrumentPanelPreferences = () => value;
export function saveInstrumentPanelPreferences(next: Partial<InstrumentPanelPreferences>): boolean {
    const candidate = {
        ...value,
        ...next,
        hidden: INSTRUMENT_SECTIONS.filter((id) => (next.hidden ?? value.hidden).includes(id)),
    };
    try {
        localStorage.setItem(key(), JSON.stringify(candidate));
        value = candidate;
        emit();
        return true;
    } catch {
        return false;
    }
}
export const subscribeInstrumentPanelPreferences = (listener: () => void) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
};
export function useInstrumentPanelPreferences() {
    return useSyncExternalStore(
        subscribeInstrumentPanelPreferences,
        getInstrumentPanelPreferences,
        getInstrumentPanelPreferences,
    );
}
/** Fixed order; an empty panel always retains the device clock, even if hidden. */
export function visibleInstrumentSections(
    data: Partial<Record<InstrumentSection, boolean>>,
    prefs: InstrumentPanelPreferences,
): InstrumentSection[] {
    const sections = INSTRUMENT_SECTIONS.filter((id) => data[id] && !prefs.hidden.includes(id));
    return sections.length ? sections : ['Clock'];
}
