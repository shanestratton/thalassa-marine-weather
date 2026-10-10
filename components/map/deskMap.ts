/**
 * The desk map (127-DESKMAP A2): the web planner's own base and seamark
 * switch, picked on this computer and kept on it alone.
 *
 * Shane 2026-10-10: "we will need to have a fairly good map to use, on the
 * desktop as the underlying map is dark". The desk opens on Light with
 * OpenSeaMap's seamarks on; a saved Obs base no longer turns it dark, and a
 * desk pick never reaches the phone (no account setting, no sync, no DB).
 *
 * One localStorage key, `thalassa_desk_map_v1` = { base?, seamarks? }. A field
 * is written only once picked, so a later default change still reaches every
 * computer that never picked. Every read and write is guarded: a private
 * window, blocked storage or a thumbnail capture opens on the defaults.
 */
import { useSyncExternalStore } from 'react';
import type { MapBaseKind } from './MapBaseSelector';
import { boatChartsLine } from '../../services/enc/boatChartsWords';

export const DESK_MAP_KEY = 'thalassa_desk_map_v1';
type DeskBase = 'light' | 'reliefSat' | 'hybrid';
const DESK_BASES: readonly unknown[] = ['light', 'reliefSat', 'hybrid'];
interface DeskPicks {
    base?: DeskBase;
    seamarks?: boolean;
}

function readPicks(): DeskPicks {
    try {
        const { base, seamarks } = JSON.parse(localStorage.getItem(DESK_MAP_KEY) ?? '{}') ?? {};
        return {
            ...(DESK_BASES.includes(base) && { base: base as DeskBase }),
            ...(typeof seamarks === 'boolean' && { seamarks }),
        };
    } catch {
        return {};
    }
}

// ONE copy of the picks for every mounted desk map: the Route map dialog and
// the App's kept-alive tracer can be up together, and a pick on one must reach
// the other at once, not after a reload. Read from storage again once no desk
// map is mounted (a pick in another tab then lands on the next open).
let picks: DeskPicks | null = null;
const listeners = new Set<() => void>();
const snapshot = () => (picks ??= readPicks());
const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
        if (!listeners.size) picks = null;
    };
};
function pick(next: DeskPicks): void {
    picks = { ...snapshot(), ...next };
    try {
        localStorage.setItem(DESK_MAP_KEY, JSON.stringify({ ...readPicks(), ...next }));
    } catch {
        /* storage unavailable: the pick lasts this session */
    }
    for (const listener of listeners) listener();
}

export function useDeskMap() {
    const { base = 'light', seamarks = true } = useSyncExternalStore(subscribe, snapshot);
    return {
        deskBase: base,
        setDeskBase: (next: MapBaseKind) => DESK_BASES.includes(next) && pick({ base: next as DeskBase }),
        deskSeamarks: seamarks,
        toggleDeskSeamarks: () => pick({ seamarks: !seamarks }),
    };
}

/**
 * Slot 0 of the desk's strip (127-DESKMAP C1). A licensed account sees where
 * its charts are, everywhere. Everyone else sees "No chart for this area"
 * where no registered cell meets the view, and a blank box (kept, so the
 * strip never jumps) where a NOAA cell is on screen: the chart speaks for
 * itself.
 */
export function deskSlot0Line(o: {
    licensed: boolean | null | undefined;
    boatName: string | null;
    chartInView: boolean;
}) {
    return o.licensed === true
        ? { text: boatChartsLine('web', o.boatName, 'strip'), hidden: false }
        : { text: boatChartsLine('web-open', null, 'strip'), hidden: o.chartInView };
}
