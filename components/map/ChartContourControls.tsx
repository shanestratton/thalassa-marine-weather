import React from 'react';
import {
    effectiveChartContours,
    parseChartContours,
    suggestedChartContours,
    type ChartContours,
} from '../../services/enc/chartContours';
import { FEET_PER_METRE } from '../../services/units';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../../services/authIdentityScope';
const keys = ['shallowM', 'safetyM', 'deepM'] as const;
const names = ['Shallow', 'Safety', 'Deep'];
const button = 'min-h-[44px] rounded-lg border border-white/20 px-3 py-2 text-sm disabled:opacity-40';
const format = (m: number, unit: 'm' | 'ft') =>
    !Number.isFinite(m) ? 'unknown' : (unit === 'ft' ? m * FEET_PER_METRE : m).toFixed(2).replace(/\.?0+$/, '');
export interface ChartContourControlsProps {
    value: unknown;
    requiredM: number;
    draftAssumed: boolean;
    unit: 'm' | 'ft';
    onChange: (value: ChartContours | null) => void;
}
export default function ChartContourControls({
    value,
    requiredM,
    draftAssumed,
    unit,
    onChange,
}: ChartContourControlsProps) {
    const scope = React.useRef(getAuthIdentityScope());
    const initial = React.useMemo(
        () => parseChartContours(value) ?? suggestedChartContours(requiredM),
        [value, requiredM],
    );
    const original = React.useMemo(
        () => (initial ? keys.map((k) => format(initial[k], unit)) : ['', '', '']),
        [initial, unit],
    );
    const [fields, setFields] = React.useState(original),
        [relief, setRelief] = React.useState(initial?.reliefSafety === true),
        [error, setError] = React.useState(''),
        [notice, setNotice] = React.useState('');
    React.useEffect(() => {
        setFields(original);
        setRelief(initial?.reliefSafety === true);
        setError('');
    }, [initial, original]);
    const effective = effectiveChartContours(value, requiredM);
    function save() {
        if (!isAuthIdentityScopeCurrent(scope.current)) return;
        const depths = fields.map((text, i) =>
            text === original[i] && initial
                ? initial[keys[i]]
                : /^(?:\d+\.?\d*|\.\d+)$/.test(text.trim())
                  ? Number(text) / (unit === 'ft' ? FEET_PER_METRE : 1)
                  : NaN,
        );
        const parsed = parseChartContours({
            shallowM: depths[0],
            safetyM: depths[1],
            deepM: depths[2],
            reliefSafety: relief,
        });
        if (!parsed) {
            setNotice('');
            setError(`Enter ordered depths: shallow < safety < deep, up to ${format(6000, unit)} ${unit}.`);
            return;
        }
        onChange(parsed);
        setError('');
        setNotice('Chart display updated.');
    }
    return (
        <fieldset className="space-y-2" aria-label="Chart contour bands">
            <legend className="font-bold">Chart depth bands</legend>
            <p className="text-xs text-slate-400">
                Metres at chart datum are used internally. Colours and the bold contour can be more cautious; routes and
                alarms keep the vessel’s own margin.
            </p>
            <div className="grid grid-cols-3 gap-2">
                {keys.map((key, i) => (
                    <label key={key} className="min-w-0 text-xs">
                        {names[i]} ({unit})
                        <input
                            className="mt-1 block min-h-[44px] w-full min-w-0 rounded-lg border border-white/20 bg-slate-900 px-2 text-base text-slate-100"
                            inputMode="decimal"
                            type="text"
                            maxLength={12}
                            value={fields[i]}
                            disabled={!initial}
                            onChange={(event) =>
                                setFields((previous) => previous.map((v, n) => (n === i ? event.target.value : v)))
                            }
                        />
                    </label>
                ))}
            </div>
            <p className="text-xs">
                Vessel minimum: {format(requiredM, unit)} {unit} (draft + margin).{' '}
                {draftAssumed ? 'Draft is assumed; check the vessel profile.' : ''} The bold line uses the next
                available deeper contour in each cell.
            </p>
            <label className="flex min-h-[44px] items-center gap-2">
                <input
                    type="checkbox"
                    checked={relief}
                    onChange={(event) => setRelief(event.target.checked)}
                    className="h-5 w-5 shrink-0"
                />
                Relief safety marker · not for navigation
            </label>
            <p className="text-xs text-slate-400">
                Relief is a coarse depth model whose datum can differ from ENC. Its amber marker is approximate; other
                relief shading remains unverified.
            </p>
            <p className="text-xs">
                {effective
                    ? `Active: ${format(effective.shallowM, unit)} / ${format(effective.safetyM, unit)} / ${format(effective.deepM, unit)} ${unit}.`
                    : 'Standard chart bands are active.'}{' '}
                {effective && effective.safetyM !== parseChartContours(value)?.safetyM
                    ? 'Safety is raised to the vessel minimum.'
                    : ''}
            </p>
            {error && (
                <p role="alert" className="text-amber-200">
                    {error}
                </p>
            )}
            {notice && <p role="status">{notice}</p>}
            <div className="grid grid-cols-2 gap-2">
                <button
                    type="button"
                    className={button}
                    disabled={!initial}
                    onClick={(event) => {
                        event.currentTarget.focus({ preventScroll: true });
                        save();
                    }}
                >
                    Apply bands
                </button>
                <button
                    type="button"
                    className={button}
                    onClick={(event) => {
                        event.currentTarget.focus({ preventScroll: true });
                        if (!isAuthIdentityScopeCurrent(scope.current)) return;
                        // null survives the existing JSON cloud merge; undefined
                        // would omit the reset and resurrect the previous choice.
                        onChange(null);
                        setNotice('Standard bands restored.');
                    }}
                >
                    Reset bands
                </button>
            </div>
        </fieldset>
    );
}
