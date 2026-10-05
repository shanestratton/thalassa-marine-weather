/**
 * The refine controls the quick log and a sighting's edit share: how many
 * (48 px steppers, never below one), a calf, and photos. A photo is stripped
 * of every metadata segment before it is kept (services/sightings/photoStrip):
 * one that cannot be cleaned is refused, never kept as it was.
 */
import React, { useId, useRef, useState } from 'react';
import { addSightingPhoto, removeSightingPhoto } from '../../services/sightings/sightingService';
import { SIGHTING_LIMITS, type LocalSighting, type SightingGroup } from '../../services/sightings/types';
import { SightingIcon } from './SightingGlyphs';

/** Who sees a sighting's photos, in words: never the public in v1. */
export function photoAudience(record: Pick<LocalSighting, 'ownerUserId' | 'row'>): string {
    if (!record.ownerUserId || record.row.visibility === 'private') return 'only you';
    return 'you and your crew only';
}

/** Calves are a mammal thing here: whales, dolphins and dugongs. */
export const CALF_GROUPS: ReadonlySet<SightingGroup> = new Set<SightingGroup>(['whale', 'dolphin', 'dugong']);

export const CountStepper: React.FC<{
    value: number;
    onChange: (count: number) => void;
    label: string;
    hint?: string;
}> = ({ value, onChange, label, hint }) => {
    const id = useId();
    return (
        <div className="flex items-center justify-between gap-3">
            <div>
                <div id={id} className="sg-eyebrow">
                    {label}
                </div>
                {hint && <div className="sg-note">{hint}</div>}
            </div>
            <div role="group" aria-labelledby={id} className="flex items-center gap-2">
                <button
                    type="button"
                    aria-label="One fewer"
                    disabled={value <= 1}
                    onClick={() => onChange(value - 1)}
                    className="sg-toggle sg-step"
                >
                    −
                </button>
                <output aria-live="polite" className="w-12 text-center text-[28px] font-black tabular-nums text-white">
                    {value}
                </output>
                <button
                    type="button"
                    aria-label="One more"
                    disabled={value >= SIGHTING_LIMITS.countMax}
                    onClick={() => onChange(value + 1)}
                    className="sg-toggle sg-step"
                >
                    +
                </button>
            </div>
        </div>
    );
};

export const CalfAndPhotos: React.FC<{
    record: LocalSighting;
    showCalf: boolean;
    onCalf: () => void;
    onRecord: (record: LocalSighting) => void;
}> = ({ record, showCalf, onCalf, onRecord }) => {
    const input = useRef<HTMLInputElement>(null);
    const [note, setNote] = useState<string | null>(null);

    const add = async (file: File | undefined) => {
        if (!file) return;
        setNote('Cleaning the photo of its location data…');
        try {
            const saved = await addSightingPhoto(record.id, file);
            if (saved) onRecord(saved);
            setNote(null);
        } catch {
            setNote('That photo couldn’t be cleaned of its location data, so it wasn’t added.');
        }
        if (input.current) input.current.value = '';
    };

    return (
        <div>
            <div className="flex gap-2">
                {showCalf && (
                    <button
                        type="button"
                        aria-pressed={record.row.has_calf}
                        onClick={onCalf}
                        className="sg-toggle sg-pill flex-1"
                    >
                        {record.row.has_calf && <SightingIcon name="check" className="h-3.5 w-3.5" />}
                        Calf with them
                    </button>
                )}
                <button
                    type="button"
                    onClick={() => input.current?.click()}
                    disabled={record.photos.length >= SIGHTING_LIMITS.photosMax}
                    className="sg-toggle sg-pill flex-1"
                >
                    <SightingIcon name="camera" className="h-4 w-4" />
                    {record.photos.length > 0 ? `Photos: ${record.photos.length}` : 'Add photo'}
                </button>
                <input
                    ref={input}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    aria-hidden="true"
                    tabIndex={-1}
                    onChange={(e) => void add(e.target.files?.[0])}
                />
            </div>
            {record.photos.length > 0 && (
                <div className="mt-1.5 flex flex-wrap items-center gap-x-2 sg-note">
                    <span>Location data removed · {photoAudience(record)}</span>
                    {record.photos.map((p) => (
                        <button
                            key={p.slot}
                            type="button"
                            onClick={() => void removeSightingPhoto(record.id, p.slot).then((r) => r && onRecord(r))}
                            className="sg-link"
                        >
                            Remove photo {p.slot + 1}
                        </button>
                    ))}
                </div>
            )}
            {note && (
                <p className="mt-1.5 sg-note" role="status">
                    {note}
                </p>
            )}
        </div>
    );
};
