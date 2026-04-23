/**
 * usePersistedState — useState but backed by localStorage.
 *
 * Survives component unmount/remount (e.g. tab switches that tear the
 * component tree down). Not intended for frequently-changing values
 * that don't need to survive — use plain useState for those.
 *
 * Serialization defaults to JSON.stringify / JSON.parse. Pass custom
 * serialize/deserialize if the value isn't JSON-native (e.g. Set).
 *
 * @example boolean / number / string:
 *   const [visible, setVisible] = usePersistedState('ais_visible', false);
 *
 * @example Set<string>:
 *   const [ids, setIds] = usePersistedState<Set<string>>(
 *     'chart_ids', new Set(),
 *     (s) => JSON.stringify([...s]),
 *     (s) => new Set(JSON.parse(s)),
 *   );
 */
import { useState, useEffect, useRef, type Dispatch, type SetStateAction } from 'react';

export function usePersistedState<T>(
    key: string,
    defaultValue: T,
    serialize: (v: T) => string = JSON.stringify,
    deserialize: (s: string) => T = JSON.parse,
): [T, Dispatch<SetStateAction<T>>] {
    // Keep serialize/deserialize refs stable so the write-effect only
    // reacts to value changes, not re-identified function props.
    const serializeRef = useRef(serialize);
    const deserializeRef = useRef(deserialize);
    serializeRef.current = serialize;
    deserializeRef.current = deserialize;

    const [value, setValue] = useState<T>(() => {
        try {
            if (typeof localStorage === 'undefined') return defaultValue;
            const stored = localStorage.getItem(key);
            if (stored !== null) return deserializeRef.current(stored);
        } catch {
            /* malformed JSON / quota / privacy mode — fall back to default */
        }
        return defaultValue;
    });

    useEffect(() => {
        try {
            if (typeof localStorage === 'undefined') return;
            localStorage.setItem(key, serializeRef.current(value));
        } catch {
            /* quota / privacy mode — drop write */
        }
    }, [key, value]);

    return [value, setValue];
}

/**
 * Convenience wrapper for Set<string> persisted as a JSON array.
 */
export function usePersistedStringSet(
    key: string,
    defaultValue: Set<string> = new Set(),
): [Set<string>, Dispatch<SetStateAction<Set<string>>>] {
    return usePersistedState<Set<string>>(
        key,
        defaultValue,
        (s) => JSON.stringify([...s]),
        (s) => {
            const arr = JSON.parse(s);
            return Array.isArray(arr) ? new Set(arr.map(String)) : new Set();
        },
    );
}
