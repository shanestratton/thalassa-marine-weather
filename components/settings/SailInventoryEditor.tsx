import React, { useId, useState } from 'react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { OverlayPortal } from '../ui/OverlayPortal';
import {
    EMPTY_SAIL_INVENTORY,
    parseSailInventory,
    type InventorySail,
    type SailInventory,
} from '../../services/sailing/sailInventory';

const inputClass = 'min-h-11 w-full rounded-lg border border-white/20 bg-slate-900 px-2 text-sm text-white';
const buttonClass = 'min-h-11 rounded-lg border border-white/20 px-3 text-sm font-bold text-sky-200';

export default function SailInventoryEditor(props: {
    value: unknown;
    vesselName: string;
    onSave: (value: SailInventory) => void;
    onClose: () => void;
}) {
    const [draft, setDraft] = useState<SailInventory>(
        () => parseSailInventory(props.value) ?? structuredClone(EMPTY_SAIL_INVENTORY),
    );
    const [error, setError] = useState('');
    const root = useFocusTrap(true, { onEscape: props.onClose });
    const titleId = useId();
    const patchSail = (index: number, patch: Partial<InventorySail>) =>
        setDraft((old) => ({
            ...old,
            sails: old.sails.map((sail, i) => (i === index ? { ...sail, ...patch } : sail)),
        }));
    const patchPlan = (index: number, patch: Partial<SailInventory['plans'][number]>) =>
        setDraft((old) => ({
            ...old,
            plans: old.plans.map((plan, i) => (i === index ? { ...plan, ...patch } : plan)),
        }));
    return (
        <OverlayPortal>
            <div className="fixed inset-0 z-[9000] flex items-center justify-center bg-black/70 p-2">
                <div
                    ref={root}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby={titleId}
                    className="flex max-h-[90dvh] w-full max-w-2xl flex-col rounded-2xl border border-white/20 bg-slate-950 text-white shadow-2xl"
                >
                    <header className="flex shrink-0 items-start justify-between gap-2 border-b border-white/10 p-4">
                        <h2 id={titleId} className="min-w-0 break-words text-lg font-bold">
                            Sails · {props.vesselName}
                        </h2>
                        <button type="button" className={buttonClass} onClick={props.onClose}>
                            Close
                        </button>
                    </header>
                    <div className="space-y-5 overflow-y-auto p-4">
                        <p className="text-sm text-gray-300">
                            Enter this boat's sails and true-wind reef points. Crossover plans choose the sails and
                            minimum reef. Your reef points can add reefs sooner; no boat or rig is assumed.
                        </p>
                        {draft.sails.map((sail, index) => (
                            <fieldset key={sail.id} className="space-y-2 rounded-xl border border-white/15 p-3">
                                <legend className="px-1 text-sm">Sail {index + 1}</legend>
                                <label className="block text-sm">
                                    Name
                                    <input
                                        className={inputClass}
                                        value={sail.name}
                                        maxLength={60}
                                        onChange={(event) => patchSail(index, { name: event.target.value })}
                                    />
                                </label>
                                <label className="block text-sm">
                                    Kind
                                    <select
                                        className={`${inputClass} appearance-none`}
                                        value={sail.kind}
                                        onChange={(event) =>
                                            patchSail(index, { kind: event.target.value as InventorySail['kind'] })
                                        }
                                    >
                                        {['main', 'headsail', 'mizzen', 'spinnaker', 'other'].map((kind) => (
                                            <option key={kind}>{kind}</option>
                                        ))}
                                    </select>
                                </label>
                                <label className="block text-sm">
                                    Reef points (kn, comma separated)
                                    <input
                                        className={inputClass}
                                        defaultValue={sail.reefPointsKn.join(', ')}
                                        onChange={(event) =>
                                            patchSail(index, {
                                                reefPointsKn: event.target.value.trim()
                                                    ? event.target.value.split(',').map((value) => Number(value.trim()))
                                                    : [],
                                            })
                                        }
                                        placeholder="Your thresholds, low to high"
                                    />
                                </label>
                                <button
                                    type="button"
                                    className={buttonClass}
                                    onClick={() =>
                                        setDraft((old) => ({
                                            ...old,
                                            sails: old.sails.filter((s) => s.id !== sail.id),
                                            plans: old.plans.map((p) => ({
                                                ...p,
                                                sails: p.sails.filter((item) => item.sailId !== sail.id),
                                            })),
                                        }))
                                    }
                                >
                                    Remove sail {index + 1}
                                </button>
                            </fieldset>
                        ))}
                        <button
                            type="button"
                            className={buttonClass}
                            disabled={draft.sails.length >= 24}
                            onClick={() =>
                                setDraft((old) => ({
                                    ...old,
                                    sails: [
                                        ...old.sails,
                                        { id: crypto.randomUUID(), name: '', kind: 'other', reefPointsKn: [] },
                                    ],
                                }))
                            }
                        >
                            Add sail
                        </button>
                        <h3 className="font-bold">Crossover plans</h3>
                        <p className="text-sm text-gray-400">
                            Use true wind angle from 0° to 180°. In overlapping wind ranges the plan with the higher
                            lower threshold wins. Gaps show unavailable. Gusts count when the selected forecast
                            publishes them.
                        </p>
                        {draft.plans.map((plan, index) => (
                            <fieldset key={plan.id} className="space-y-3 rounded-xl border border-white/15 p-3">
                                <legend className="px-1 text-sm">Plan {index + 1}</legend>
                                <label className="block text-sm">
                                    Plan name
                                    <input
                                        className={inputClass}
                                        maxLength={60}
                                        value={plan.name}
                                        onChange={(event) => patchPlan(index, { name: event.target.value })}
                                    />
                                </label>
                                <div className="grid grid-cols-2 gap-2">
                                    {(['minTwsKn', 'maxTwsKn', 'minTwaDeg', 'maxTwaDeg'] as const).map((key, i) => (
                                        <label key={key} className="block text-sm">
                                            {
                                                [
                                                    'Minimum wind (kn)',
                                                    'Maximum wind (kn)',
                                                    'Minimum angle (°)',
                                                    'Maximum angle (°)',
                                                ][i]
                                            }
                                            <input
                                                className={inputClass}
                                                type="number"
                                                min="0"
                                                max={i < 2 ? 100 : 180}
                                                value={Number.isFinite(plan[key]) ? plan[key] : ''}
                                                onChange={(event) =>
                                                    patchPlan(index, {
                                                        [key]:
                                                            event.target.value === ''
                                                                ? NaN
                                                                : Number(event.target.value),
                                                    })
                                                }
                                            />
                                        </label>
                                    ))}
                                </div>
                                {draft.sails.map((sail) => {
                                    const choice = plan.sails.find((item) => item.sailId === sail.id);
                                    return (
                                        <div key={sail.id} className="flex flex-wrap items-center gap-2">
                                            <label className="flex min-h-11 items-center gap-2 text-sm">
                                                <input
                                                    type="checkbox"
                                                    checked={!!choice}
                                                    onChange={(event) =>
                                                        patchPlan(index, {
                                                            sails: event.target.checked
                                                                ? [...plan.sails, { sailId: sail.id, reef: 0 }]
                                                                : plan.sails.filter((item) => item.sailId !== sail.id),
                                                        })
                                                    }
                                                />
                                                <span className="min-w-0 break-words">
                                                    {sail.name || 'Unnamed sail'}
                                                </span>
                                            </label>
                                            {choice && (
                                                <label className="text-sm">
                                                    Minimum reef
                                                    <select
                                                        className={`${inputClass} appearance-none`}
                                                        value={choice.reef}
                                                        onChange={(event) =>
                                                            patchPlan(index, {
                                                                sails: plan.sails.map((item) =>
                                                                    item.sailId === sail.id
                                                                        ? { ...item, reef: Number(event.target.value) }
                                                                        : item,
                                                                ),
                                                            })
                                                        }
                                                    >
                                                        {Array.from(
                                                            { length: sail.reefPointsKn.length + 1 },
                                                            (_, reef) => (
                                                                <option key={reef} value={reef}>
                                                                    {reef ? `Reef ${reef}` : 'Full'}
                                                                </option>
                                                            ),
                                                        )}
                                                    </select>
                                                </label>
                                            )}
                                        </div>
                                    );
                                })}
                                <button
                                    type="button"
                                    className={buttonClass}
                                    onClick={() =>
                                        setDraft((old) => ({
                                            ...old,
                                            plans: old.plans.filter((p) => p.id !== plan.id),
                                        }))
                                    }
                                >
                                    Remove plan {index + 1}
                                </button>
                            </fieldset>
                        ))}
                        <button
                            type="button"
                            className={buttonClass}
                            disabled={draft.plans.length >= 32 || !draft.sails.length}
                            onClick={() =>
                                setDraft((old) => ({
                                    ...old,
                                    plans: [
                                        ...old.plans,
                                        {
                                            id: crypto.randomUUID(),
                                            name: '',
                                            minTwsKn: 0,
                                            maxTwsKn: 1,
                                            minTwaDeg: 0,
                                            maxTwaDeg: 180,
                                            sails: [],
                                        },
                                    ],
                                }))
                            }
                        >
                            Add crossover plan
                        </button>
                        <label className="block text-sm">
                            Wind drop before shaking reefs out (kn)
                            <input
                                className={inputClass}
                                type="number"
                                min="0"
                                max="5"
                                step="0.5"
                                value={Number.isFinite(draft.hysteresisKn) ? draft.hysteresisKn : ''}
                                onChange={(event) =>
                                    setDraft((old) => ({
                                        ...old,
                                        hysteresisKn: event.target.value === '' ? NaN : Number(event.target.value),
                                    }))
                                }
                            />
                        </label>
                        <p className="text-sm text-gray-400">
                            Stronger wind takes effect immediately. Reduced sail is held within this band as wind falls.
                            Recommendations are passage advice; check the actual conditions and your sailmaker's limits
                            aboard.
                        </p>
                        {error && (
                            <p role="alert" className="text-sm text-rose-300">
                                {error}
                            </p>
                        )}
                    </div>
                    <footer className="flex shrink-0 justify-end border-t border-white/10 p-3">
                        <button
                            type="button"
                            className={buttonClass}
                            onClick={() => {
                                const value = parseSailInventory(draft);
                                if (!value) {
                                    setError(
                                        'Check names, increasing reef points, wind/angle ranges and every selected sail.',
                                    );
                                    return;
                                }
                                props.onSave(value);
                                props.onClose();
                            }}
                        >
                            Save sail inventory
                        </button>
                    </footer>
                </div>
            </div>
        </OverlayPortal>
    );
}
