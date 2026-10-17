import React, { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
} from '../../services/authIdentityScope';
import { editPrivateCatch, loadPrivateCatch } from '../../services/sightings/privateCatch';
import { ensureSightingSyncTriggers, scheduleSightingDrain } from '../../services/sightings/sightingSync';
import type { LocalSighting, PrivateCatch } from '../../services/sightings/types';

const empty: PrivateCatch = { species: null, length_cm: null, disposition: null };

/** These fields deliberately never use the shared species/remarks editors. */
export const PrivateCatchFields: React.FC<{
    record: LocalSighting;
    onRecord: (record: LocalSighting) => void;
    editable?: boolean;
}> = ({ record, onRecord, editable = true }) => {
    const scope = useSyncExternalStore(subscribeAuthIdentityScope, getAuthIdentityScope);
    const id = useId(),
        alive = useRef(true),
        changed = useRef(false);
    const callback = useRef(onRecord);
    callback.current = onRecord;
    const [species, setSpecies] = useState(record.privateCatch?.species ?? '');
    const [length, setLength] = useState(record.privateCatch?.length_cm?.toString() ?? '');
    const [disposition, setDisposition] = useState<PrivateCatch['disposition']>(
        record.privateCatch?.disposition ?? null,
    );
    const [error, setError] = useState<string | null>(null);
    const eligible =
        record.ownerUserId === scope.userId &&
        record.row.observer_id === scope.userId &&
        record.row.taxon_group === 'fish' &&
        record.sync.op !== 'delete';
    useEffect(() => {
        alive.current = true;
        if (eligible)
            void loadPrivateCatch(record.id).then((fresh) => {
                if (!fresh || !alive.current || !isAuthIdentityScopeCurrent(scope) || changed.current) return;
                const value = fresh.privateCatch ?? empty;
                setSpecies(value.species ?? '');
                setLength(value.length_cm?.toString() ?? '');
                setDisposition(value.disposition);
                callback.current(fresh);
            });
        return () => {
            alive.current = false;
        };
    }, [record.id, eligible, scope]);
    const save = async (nextDisposition = disposition) => {
        const result = await editPrivateCatch(record.id, {
            species,
            length_cm: length.trim() ? Number(length) : null,
            disposition: nextDisposition,
        });
        if (!isAuthIdentityScopeCurrent(scope)) return;
        if (result.record) {
            if (scope.userId) {
                ensureSightingSyncTriggers();
                scheduleSightingDrain(0);
            }
            if (alive.current) callback.current(result.record);
        }
        if (alive.current) setError(result.error);
    };
    if (!eligible) return null;
    const status = !scope.userId
        ? 'Saved on this phone only.'
        : record.privateCatchSync?.error === 'not-available'
          ? 'Saved on this phone. Private cloud storage is not available yet.'
          : record.privateCatchSync?.pending
            ? 'Saved on this phone. Private sync pending.'
            : 'Only you can see these details.';
    return (
        <section className="sg-card sg-catch-details mt-3 space-y-3 p-3" aria-labelledby={`${id}-heading`}>
            <h3 id={`${id}-heading`} className="text-[14px] font-bold">
                Catch details · only you
            </h3>
            {editable ? (
                <>
                    <label className="block text-[13px]">
                        Catch species
                        <input
                            className="sg-toggle mt-1 min-h-[44px] w-full rounded-xl px-3"
                            value={species}
                            maxLength={120}
                            placeholder="Optional"
                            onChange={(e) => {
                                changed.current = true;
                                setSpecies(e.target.value);
                            }}
                            onBlur={() => void save()}
                        />
                    </label>
                    <label className="block text-[13px]">
                        Length (cm)
                        <input
                            className="sg-toggle mt-1 min-h-[44px] w-full rounded-xl px-3"
                            type="number"
                            inputMode="decimal"
                            min="0.1"
                            max="2000"
                            step="0.1"
                            value={length}
                            placeholder="Optional"
                            onChange={(e) => {
                                changed.current = true;
                                setLength(e.target.value);
                            }}
                            onBlur={() => void save()}
                        />
                    </label>
                    <label className="block text-[13px]">
                        Kept or released
                        <select
                            className="sg-toggle sg-catch-select mt-1 min-h-[44px] w-full rounded-xl px-3"
                            value={disposition ?? ''}
                            onChange={(e) => {
                                changed.current = true;
                                const value =
                                    e.target.value === 'kept'
                                        ? 'kept'
                                        : e.target.value === 'released'
                                          ? 'released'
                                          : null;
                                setDisposition(value);
                                void save(value);
                            }}
                        >
                            <option value="">Not recorded</option>
                            <option value="kept">Kept</option>
                            <option value="released">Released</option>
                        </select>
                    </label>
                </>
            ) : (
                <p className="text-[13px]">
                    {[
                        species || null,
                        length ? `${length} cm` : null,
                        disposition === 'kept' ? 'Kept' : disposition === 'released' ? 'Released' : null,
                    ]
                        .filter(Boolean)
                        .join(' · ') || 'No catch details recorded.'}
                </p>
            )}
            <p className="text-[12px] sg-muted" role="status">
                {status}
            </p>
            {error && (
                <p className="text-[13px] sg-amber-strong" role="alert">
                    {error}
                </p>
            )}
        </section>
    );
};
