import React from 'react';
import type { MarineRadarEquipment, MarineRadarMake } from '../../types/marineRadar';
import { RADAR_MAKES, RADAR_MODELS, radarEquipment } from '../../services/radar/radarEquipment';
import { checkPairedRadarEquipment, type RadarEquipmentRead } from '../../services/radar/radarEquipmentRead';
import { RADAR_REPORT_MAX_AGE_MS } from '../../utils/radarTarget';
import { PiRadarError } from '../../services/radar/piRadar';
import { ModalSheet } from '../ui/ModalSheet';
const field = 'min-h-11 w-full min-w-0 rounded-xl border border-white/15 bg-slate-950 p-3 text-sm text-white';
export default function MarineRadarEquipmentSheet({
    value,
    canDetect,
    isCurrent,
    onClose,
    onSave,
}: {
    value: unknown;
    canDetect: boolean;
    isCurrent: () => boolean;
    onClose: () => void;
    onSave: (value: MarineRadarEquipment | null) => void;
}) {
    const saved = radarEquipment(value),
        [make, setMake] = React.useState<MarineRadarMake | ''>(saved?.make ?? ''),
        [modelId, setModel] = React.useState(saved?.modelId ?? ''),
        [detail, setDetail] = React.useState(saved?.detail ?? ''),
        [busy, setBusy] = React.useState(false),
        [result, setResult] = React.useState<RadarEquipmentRead | null>(null),
        [message, setMessage] = React.useState<string | null>(null),
        pending = React.useRef<AbortController | null>(null),
        serial = React.useRef(0),
        fid = React.useId();
    const cancel = React.useCallback(() => {
        serial.current++;
        pending.current?.abort();
        pending.current = null;
        setBusy(false);
    }, []);
    React.useEffect(
        () => () => {
            serial.current++;
            pending.current?.abort();
        },
        [],
    );
    const close = () => {
        cancel();
        onClose();
    };
    const detect = async () => {
        cancel();
        setResult(null);
        setMessage(null);
        if (!canDetect) {
            setMessage('Select a saved vessel profile before checking the paired Pi feed.');
            return;
        }
        if (!isCurrent()) {
            close();
            return;
        }
        const controller = new AbortController(),
            ticket = serial.current;
        pending.current = controller;
        setBusy(true);
        const current = () => ticket === serial.current && !controller.signal.aborted && isCurrent();
        try {
            const read = await checkPairedRadarEquipment({ signal: controller.signal, isCurrent: current });
            if (current() && read.isCurrent()) setResult(read);
        } catch (error) {
            if (current())
                setMessage(
                    error instanceof PiRadarError && error.code === 'update'
                        ? 'The paired Pi needs the radar target update. The saved equipment has not changed.'
                        : 'A current paired Pi radar feed could not be verified. Choose the equipment manually.',
                );
        } finally {
            if (ticket === serial.current) {
                pending.current = null;
                setBusy(false);
            }
        }
    };
    const recent =
        result?.lastFrameAt !== null &&
        result?.lastFrameAt !== undefined &&
        result.lastFrameAt <= result.checkedAt + 1000 &&
        result.checkedAt - result.lastFrameAt <= RADAR_REPORT_MAX_AGE_MS;
    return (
        <ModalSheet isOpen title="Marine radar" onClose={close} fitViewport>
            <div className="space-y-4 p-4 text-sm text-slate-200" data-testid="marine-radar-equipment">
                <p>
                    Record the radar fitted to this vessel. Selecting a model does not connect its radar image to Obs.
                </p>
                <div className="relative">
                    <label className="mb-1 block font-bold" htmlFor={`${fid}-make`}>
                        Make
                    </label>
                    <select
                        id={`${fid}-make`}
                        className={`${field} appearance-none pr-8`}
                        value={make}
                        onChange={(event) => {
                            setMake(event.target.value as MarineRadarMake | '');
                            setModel('');
                            setDetail('');
                        }}
                    >
                        <option value="">Not recorded</option>
                        {RADAR_MAKES.map((m) => (
                            <option key={m.id} value={m.id}>
                                {m.name}
                            </option>
                        ))}
                    </select>
                    <span aria-hidden className="pointer-events-none absolute bottom-3 right-3">
                        ▾
                    </span>
                </div>
                {make && (
                    <>
                        <div className="relative">
                            <label className="mb-1 block font-bold" htmlFor={`${fid}-model`}>
                                Model
                            </label>
                            <select
                                id={`${fid}-model`}
                                className={`${field} appearance-none pr-8`}
                                value={modelId}
                                onChange={(event) => setModel(event.target.value)}
                            >
                                <option value="">Other / model unknown</option>
                                {RADAR_MODELS.filter((m) => m.make === make).map((m) => (
                                    <option key={m.id} value={m.id}>
                                        {m.name}
                                    </option>
                                ))}
                            </select>
                            <span aria-hidden className="pointer-events-none absolute bottom-3 right-3">
                                ▾
                            </span>
                        </div>
                        {!modelId && (
                            <div>
                                <label className="mb-1 block font-bold" htmlFor={`${fid}-detail`}>
                                    Model details (optional)
                                </label>
                                <input
                                    id={`${fid}-detail`}
                                    className={field}
                                    value={detail}
                                    maxLength={80}
                                    onChange={(event) => setDetail(event.target.value.replace(/\p{Cc}/gu, ''))}
                                    placeholder="Make or model from the scanner label"
                                />
                            </div>
                        )}
                    </>
                )}
                <section
                    className="space-y-2 rounded-xl border border-sky-400/20 bg-sky-400/5 p-3"
                    aria-label="Radar detection"
                >
                    <p>
                        Checks the paired Pi's existing target feed. Scanner make and model identification is not
                        available yet.
                    </p>
                    <button
                        type="button"
                        className="min-h-11 rounded-xl bg-sky-700 px-4 font-bold text-white"
                        onClick={() => {
                            void detect();
                        }}
                        disabled={busy}
                    >
                        Auto-detect
                    </button>
                    {busy && (
                        <button
                            type="button"
                            className="ml-2 min-h-11 px-3 underline"
                            onClick={() => {
                                cancel();
                                setMessage('Radar check cancelled.');
                            }}
                        >
                            Cancel check
                        </button>
                    )}
                    {busy && <p role="status">Checking paired Pi feed…</p>}
                    {message && <p role="status">{message}</p>}
                    {result && result.isCurrent() && (
                        <div role="status" className="space-y-1 break-words">
                            <p className="font-bold">Paired Pi feed: {result.piName}</p>
                            <p>
                                {result.overloaded
                                    ? 'Feed capacity exceeded at check.'
                                    : !result.configured
                                      ? 'Target feed was not configured at check.'
                                      : !result.connected
                                        ? 'Target feed was disconnected at check.'
                                        : recent
                                          ? 'Recent radar target-feed sentences were present at check.'
                                          : 'Connected feed; no recent radar sentences were verified.'}
                            </p>
                            <p>
                                Scanner model unknown. The Pi does not verify which fleet vessel carries this scanner.
                                Saved equipment is unchanged.
                            </p>
                            <p className="text-xs">
                                Checked {new Date(result.checkedAt).toLocaleTimeString()}
                                {result.lastFrameAt !== null
                                    ? ` · Last frame ${new Date(result.lastFrameAt).toLocaleTimeString()}`
                                    : ' · Frame time unknown'}
                            </p>
                        </div>
                    )}
                </section>
                <p className="text-xs text-slate-400">
                    Obs can show supported tracked radar targets. Raw radar sweep imagery and scanner controls are not
                    connected by this equipment record.
                </p>
                <div className="flex flex-wrap gap-2">
                    <button
                        type="button"
                        className="min-h-11 rounded-xl bg-sky-600 px-4 font-bold text-white"
                        onClick={() => {
                            if (!isCurrent()) {
                                close();
                                return;
                            }
                            const next = make
                                ? radarEquipment({
                                      schema: 1,
                                      make,
                                      modelId: modelId || null,
                                      detail: modelId ? null : detail.trim() || null,
                                  })
                                : null;
                            if (make && !next) {
                                setMessage('Check the model details before saving.');
                                return;
                            }
                            cancel();
                            onSave(next);
                        }}
                    >
                        Save equipment
                    </button>
                    <button
                        type="button"
                        className="min-h-11 rounded-xl border border-white/20 px-4"
                        onClick={() => {
                            if (isCurrent()) {
                                cancel();
                                onSave(null);
                            } else close();
                        }}
                    >
                        Clear equipment
                    </button>
                </div>
            </div>
        </ModalSheet>
    );
}
