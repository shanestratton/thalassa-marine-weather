import React, { useEffect, useRef, useState } from 'react';
import { ModalSheet } from '../ui/ModalSheet';
import { subscribeAuthIdentityScope } from '../../services/authIdentityScope';
import {
    flushCrowdRevoke,
    readCrowdPermission,
    revokeCrowdPermission,
    saveCrowdPermission,
    type CrowdOwnedPermission,
} from '../../services/seabed/crowdConsent';
import { parseCrowdCalibration, type CrowdCalibration } from '../../services/seabed/crowdPolicy';

const button = 'min-h-11 min-w-0 rounded-lg border border-white/20 px-3 text-sm text-white disabled:opacity-40';
const field = 'mt-1 min-h-11 w-full rounded-lg border border-white/20 bg-slate-950 px-3 text-sm text-white';
const numericFields = [
    ['waterlineToTransducerM', 'Measured waterline to transducer (m)'],
    ['offsetUncertaintyM', 'Offset uncertainty bound (m)'],
    ['sounderUncertaintyM', 'Sounder uncertainty bound (m)'],
    ['checkedDepthLimitM', 'Maximum depth actually checked (m)'],
] as const;
type Form = Record<(typeof numericFields)[number][0] | 'depthSource' | 'sounderProduct' | 'measuredAt', string> & {
    depthReference: '' | 'T' | 'W';
};
const empty: Form = {
    depthReference: '',
    depthSource: '',
    sounderProduct: '',
    measuredAt: '',
    waterlineToTransducerM: '',
    offsetUncertaintyM: '',
    sounderUncertaintyM: '',
    checkedDepthLimitM: '',
};
function formFor(value: CrowdCalibration | null): Form {
    if (!value) return { ...empty };
    return {
        depthReference: value.depthReference,
        depthSource: value.depthSource,
        sounderProduct: value.sounderProduct,
        measuredAt: new Date(value.measuredAt).toISOString().slice(0, 16),
        ...Object.fromEntries(numericFields.map(([key]) => [key, String(value[key])])),
    } as Form;
}

/** Mounted only by an explicit settings opener. Private capture has its own switch. */
export default function CrowdSoundingConsentSheet({ boatId, onClose }: { boatId: string; onClose: () => void }) {
    const [owned, setOwned] = useState<CrowdOwnedPermission | null>(null);
    const [form, setForm] = useState<Form>({ ...empty });
    const [map, setMap] = useState(false),
        [dcdb, setDcdb] = useState(false),
        [confirmed, setConfirmed] = useState(false);
    const [busy, setBusy] = useState(true),
        [message, setMessage] = useState('Checking current ownership and permission…');
    const epoch = useRef(0),
        controller = useRef<AbortController | null>(null);
    const retire = React.useCallback(() => {
        ++epoch.current;
        controller.current?.abort();
    }, []);
    useEffect(() => {
        let alive = true;
        const close = () => {
            retire();
            onClose();
        };
        const load = async () => {
            const turn = ++epoch.current;
            controller.current?.abort();
            const abort = new AbortController();
            controller.current = abort;
            setOwned(null);
            setBusy(true);
            setConfirmed(false);
            try {
                await flushCrowdRevoke(boatId);
                const value = await readCrowdPermission(boatId, abort.signal);
                if (!alive || turn !== epoch.current) return;
                setOwned(value);
                setMap(value.pendingRevoke ? false : !!value.permission?.mapEnabled);
                setDcdb(value.pendingRevoke ? false : !!value.permission?.dcdbEnabled);
                setForm(formFor(value.permission?.calibration ?? null));
                setMessage(
                    value.pendingRevoke ? 'OFF is pending. Connect to deliver it before enabling either choice.' : '',
                );
            } catch {
                if (alive && turn === epoch.current)
                    setMessage('Current sharing settings are unavailable. You can still request OFF.');
            } finally {
                if (alive && turn === epoch.current) setBusy(false);
            }
        };
        void load();
        window.addEventListener('online', load);
        const unsubscribe = subscribeAuthIdentityScope(close);
        return () => {
            alive = false;
            retire();
            unsubscribe();
            window.removeEventListener('online', load);
        };
    }, [boatId, onClose, retire]);

    const off = async () => {
        const turn = ++epoch.current;
        controller.current?.abort();
        setMap(false);
        setDcdb(false);
        setOwned(null);
        setBusy(true);
        setConfirmed(false);
        try {
            const status = await revokeCrowdPermission(boatId);
            if (turn !== epoch.current) return;
            setMessage(
                status === 'saved'
                    ? 'Both public permissions are OFF. Private capture is separate.'
                    : status === 'pending'
                      ? 'OFF is saved on this device and pending delivery. Existing public copies cannot be recalled.'
                      : 'OFF could not be retained on this device. Reopen these settings online to confirm the server is OFF.',
            );
        } catch {
            if (turn === epoch.current) setMessage('OFF could not be confirmed. Reopen these settings online.');
        } finally {
            if (turn === epoch.current) setBusy(false);
        }
    };
    const update = (key: keyof Form, value: string) => {
        setForm((previous) => ({ ...previous, [key]: value }));
        setConfirmed(false);
    };
    const save = async () => {
        if (!owned || owned.pendingRevoke || !confirmed || !(map || dcdb)) return;
        const turn = ++epoch.current;
        controller.current?.abort();
        const abort = new AbortController();
        controller.current = abort;
        setBusy(true);
        try {
            const calibration = parseCrowdCalibration(
                {
                    schema: 1,
                    method: 'measured-offset-and-sounder-check',
                    depthReference: form.depthReference,
                    depthSource: form.depthSource.trim(),
                    sounderProduct: form.sounderProduct.trim(),
                    measuredAt: form.measuredAt ? Date.parse(form.measuredAt + ':00Z') : NaN,
                    ...Object.fromEntries(
                        numericFields.map(([key]) => [key, form[key].trim() ? Number(form[key]) : NaN]),
                    ),
                },
                Date.now(),
            );
            const permission = await saveCrowdPermission(
                {
                    boatId,
                    expectedRevision: owned.permission?.revision ?? null,
                    mapEnabled: map,
                    dcdbEnabled: dcdb,
                    calibration,
                },
                abort.signal,
            );
            if (turn !== epoch.current) return;
            setOwned({ ...owned, permission, pendingRevoke: false });
            setConfirmed(false);
            setMessage(
                'Choices saved for future captures. Every eligible batch waits at least 30 days; publication still requires QA and source admission.',
            );
        } catch {
            if (turn === epoch.current)
                setMessage(
                    'Saving could not be confirmed. Existing choices may remain. Check measured fields and reopen settings before retrying.',
                );
        } finally {
            if (turn === epoch.current) setBusy(false);
        }
    };
    return (
        <ModalSheet
            isOpen
            onClose={onClose}
            title="Public soundings"
            fitViewport
            maxWidth="max-w-lg"
            footer={
                <div className="grid grid-cols-2 gap-2">
                    <button
                        type="button"
                        className={button}
                        disabled={busy || !owned || owned.pendingRevoke || !confirmed || !(map || dcdb)}
                        onClick={() => void save()}
                    >
                        Save choices
                    </button>
                    <button type="button" className={button} onClick={onClose}>
                        Close
                    </button>
                </div>
            }
        >
            <div className="space-y-4 text-sm leading-relaxed text-slate-300">
                <p>
                    {owned ? owned.boatName : 'Current owner verification required'}. These choices do not start or
                    change private capture.
                </p>
                <button type="button" className={`${button} w-full text-amber-200`} onClick={() => void off()}>
                    Turn both permissions OFF
                </button>
                <p role="status" className="break-words text-amber-200">
                    {message}
                </p>
                <p>
                    Both choices start OFF. Only captures made after server confirmation can qualify, after a 30-day
                    hold and fresh privacy checks. Home berths, private places and trip ends remain excluded.
                </p>
                <label className="flex min-h-11 items-start gap-3">
                    <input
                        className="mt-1 h-5 w-5 shrink-0"
                        type="checkbox"
                        checked={map}
                        disabled={busy || !owned || owned.pendingRevoke}
                        onChange={(e) => {
                            setMap(e.target.checked);
                            setConfirmed(false);
                        }}
                    />
                    <span>
                        Allow qualified soundings in Thalassa’s public CC0 map. Unverified, display only; never routing,
                        clearance or alarms.
                    </span>
                </label>
                <label className="flex min-h-11 items-start gap-3">
                    <input
                        className="mt-1 h-5 w-5 shrink-0"
                        type="checkbox"
                        checked={dcdb}
                        disabled={busy || !owned || owned.pendingRevoke}
                        onChange={(e) => {
                            setDcdb(e.target.checked);
                            setConfirmed(false);
                        }}
                    />
                    <span>
                        Separately allow raw soundings and required metadata for IHO DCDB under CC0. Submission remains
                        held until Trusted Node admission.
                    </span>
                </label>
                <p>
                    CC0 permits anyone to copy and reuse released data. OFF stops future release; copies already made
                    public, including external archives, cannot be recalled. No owner name or vessel track is included
                    in the map. DCDB requires a persistent anonymous platform identifier.
                </p>
                <fieldset disabled={busy || !owned} className="space-y-3 border-t border-white/10 pt-3">
                    <legend className="font-semibold text-white">Measured sounder calibration</legend>
                    <p>
                        Vessel draft confirmation is insufficient. Use the instrument’s exact output source and
                        reference, a measured offset and an independent sounder check. Unknown UTC, datum or calibration
                        holds publication.
                    </p>
                    <label className="block">
                        Instrument depth reference
                        <select
                            className={field}
                            value={form.depthReference}
                            onChange={(e) => update('depthReference', e.target.value)}
                        >
                            <option value="">Choose the checked reference</option>
                            <option value="T">Below transducer (T)</option>
                            <option value="W">Below waterline (W)</option>
                        </select>
                    </label>
                    {(['depthSource', 'sounderProduct'] as const).map((key) => (
                        <label key={key} className="block">
                            {key === 'depthSource' ? 'Exact instrument source identifier' : 'Sounder make and model'}
                            <input
                                className={field}
                                maxLength={120}
                                value={form[key]}
                                onChange={(e) => update(key, e.target.value)}
                            />
                        </label>
                    ))}
                    <label className="block">
                        Calibration date and time (UTC)
                        <input
                            className={field}
                            type="datetime-local"
                            value={form.measuredAt}
                            onChange={(e) => update('measuredAt', e.target.value)}
                        />
                    </label>
                    {numericFields.map(([key, label]) => (
                        <label key={key} className="block">
                            {label}
                            <input
                                className={field}
                                type="number"
                                inputMode="decimal"
                                step="any"
                                value={form[key]}
                                onChange={(e) => update(key, e.target.value)}
                            />
                        </label>
                    ))}
                    <label className="flex min-h-11 items-start gap-3">
                        <input
                            className="mt-1 h-5 w-5 shrink-0"
                            type="checkbox"
                            checked={confirmed}
                            onChange={(e) => setConfirmed(e.target.checked)}
                        />
                        <span>
                            I checked these measurements and understand the separate CC0 choices and limits above.
                        </span>
                    </label>
                </fieldset>
            </div>
        </ModalSheet>
    );
}
