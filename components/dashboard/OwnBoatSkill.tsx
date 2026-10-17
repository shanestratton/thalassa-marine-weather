import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { OwnBoatProposal } from '../../utils/ownBoatSkill';
import type { PrivateBoatScore, PrivateBoatSession } from '../../services/weather/ownBoatSkillTransaction';
import { issuedModelLabel } from '../../services/weather/nearbyEvidence';
import { SKILL_LEADS, type SkillLead } from '../../services/weather/modelSkill';

/** Explicit private review only; the Pi adapter loads on the first button press. */
export default function OwnBoatSkill({ openReview }: { openReview?: () => Promise<PrivateBoatSession> }) {
    const [expanded, setExpanded] = useState(false),
        [busy, setBusy] = useState(false),
        [message, setMessage] = useState(''),
        [proposal, setProposal] = useState<OwnBoatProposal | null>(null),
        [associated, setAssociated] = useState(false),
        [logging, setLogging] = useState(false),
        [score, setScore] = useState<PrivateBoatScore | null>(null),
        [lead, setLead] = useState<SkillLead>('0-6h'),
        [saved, setSaved] = useState(false);
    const session = useRef<PrivateBoatSession | null>(null),
        epoch = useRef(0);
    const invalidate = useCallback(() => {
        epoch.current++;
    }, []);
    useEffect(() => {
        if (!expanded) return;
        invalidate();
        const timer = setInterval(() => {
            if (session.current && !session.current.current()) {
                session.current.release();
                session.current = null;
                setScore(null);
                setProposal(null);
                setSaved(false);
                setMessage('Private review expired or the account, vessel or Pi changed. Reopen to review again.');
            }
        }, 1000);
        return () => {
            invalidate();
            clearInterval(timer);
            session.current?.release();
            session.current = null;
        };
    }, [expanded, invalidate]);
    const act = async (task: (value: PrivateBoatSession) => Promise<void>) => {
        if (busy) return;
        setBusy(true);
        setMessage('Checking the paired Pi…');
        const version = epoch.current;
        try {
            let value = session.current;
            if (!value?.current()) {
                value?.release();
                value = await (
                    openReview ??
                    (async () => (await import('../../services/weather/ownBoatSkillSession')).openOwnBoatSkillReview())
                )();
                if (version !== epoch.current) {
                    value.release();
                    return;
                }
                session.current = value;
            }
            await task(value);
            if (version === epoch.current) setSaved(value.saved);
        } catch (error) {
            if (version === epoch.current) {
                setScore(null);
                setMessage(error instanceof Error ? error.message : 'Private scorecard unavailable.');
            }
        } finally {
            if (version === epoch.current) setBusy(false);
        }
    };
    const currentScore = score?.scores[SKILL_LEADS.indexOf(lead)];
    const button =
        'min-h-11 w-full rounded-lg border border-white/15 bg-slate-800 px-3 py-2 text-left disabled:opacity-50';
    return (
        <details
            open={expanded}
            data-testid="own-boat-skill"
            className="mt-3 min-w-0 rounded-xl border border-white/10 bg-slate-950/40 text-xs text-slate-300"
            onToggle={(event) => {
                setExpanded(event.currentTarget.open);
                setProposal(null);
                setAssociated(false);
                setLogging(false);
                setScore(null);
                setMessage('');
                setSaved(false);
                setBusy(false);
            }}
        >
            <summary className="min-h-11 cursor-pointer px-3 py-3 font-semibold text-sky-200">
                Private boat scorecard
            </summary>
            {expanded && (
                <div className="min-w-0 space-y-3 break-words px-3 pb-3">
                    <p>
                        Compare forecasts captured before the weather with this boat’s true-wind instruments. Private on
                        the paired Pi; no sharing or automatic model changes.
                    </p>
                    <p>Requires Pi update 9. An older or unpaired Pi cannot supply this private scorecard.</p>
                    <p>
                        Mast height, shelter, calibration and motion affect agreement. These instruments do not verify
                        standard 10 m wind. Rain and wave scores are unavailable without suitable measurements.
                    </p>
                    <button
                        disabled={busy}
                        className={button}
                        onClick={() =>
                            void act(async (value) => {
                                setProposal(null);
                                setAssociated(false);
                                setLogging(false);
                                setScore(null);
                                const result = await value.prepare();
                                if (!value.current()) return;
                                setProposal(result);
                                setMessage('Confirm the actual instrument association below.');
                            })
                        }
                    >
                        Review instruments
                    </button>
                    {proposal && (
                        <div className="space-y-3 rounded-lg border border-sky-500/30 p-3">
                            <p className="font-semibold text-white">{proposal.vesselName}</p>
                            <p>
                                True wind: {proposal.windSource}
                                <br />
                                Position: {proposal.positionSource}
                            </p>
                            <label className="flex min-h-11 items-start gap-2 py-2">
                                <input
                                    className="mt-1 size-5 shrink-0"
                                    type="checkbox"
                                    checked={associated}
                                    onChange={(e) => setAssociated(e.target.checked)}
                                />
                                <span>
                                    I confirm these are the selected vessel’s instruments, connected to this Pi. Pairing
                                    alone does not prove that association.
                                </span>
                            </label>
                            <label className="flex min-h-11 items-start gap-2 py-2">
                                <input
                                    className="mt-1 size-5 shrink-0"
                                    type="checkbox"
                                    checked={logging}
                                    onChange={(e) => setLogging(e.target.checked)}
                                />
                                <span>
                                    Log true wind and coarse forecast cells privately for up to 14 days. No exact track
                                    is retained by this scorecard.
                                </span>
                            </label>
                            <p>
                                Access expires in 14 days; reading lasts up to 15 minutes. Renewal needs internet and
                                verified vessel ownership. Changing the reviewed association clears its previous private
                                evidence.
                            </p>
                            <p>
                                If logout or account deletion cannot reach an offline Pi, it may keep logging until
                                local retirement or the original 14-day expiry. Stop and clear on boat Wi-Fi before
                                disconnecting.
                            </p>
                            <button
                                disabled={busy || !associated}
                                className={button}
                                onClick={() =>
                                    void act(async (value) => {
                                        await value.confirm(logging);
                                        if (!value.current()) return;
                                        setProposal(null);
                                        setAssociated(false);
                                        setMessage(
                                            logging
                                                ? 'Private logging enabled for this reviewed association.'
                                                : 'Private access saved. Logging is off.',
                                        );
                                    })
                                }
                            >
                                {logging ? 'Enable private logging' : 'Save access with logging off'}
                            </button>
                        </div>
                    )}
                    <button
                        disabled={busy}
                        className={button}
                        onClick={() =>
                            void act(async (value) => {
                                const result = await value.read();
                                if (!value.current()) return;
                                setScore(result);
                                setMessage('');
                            })
                        }
                    >
                        Read private scorecard
                    </button>
                    {(saved || session.current?.saved) && (
                        <div className="grid grid-cols-1 gap-2">
                            <button
                                disabled={busy}
                                className={button}
                                onClick={() =>
                                    void act(async (value) => {
                                        await value.off(false);
                                        if (!value.current()) return;
                                        setScore(null);
                                        setProposal(null);
                                        setMessage(
                                            'The Pi confirmed logging off. Private evidence remains on that Pi. Review access again to read or clear it.',
                                        );
                                    })
                                }
                            >
                                Stop private logging
                            </button>
                            <button
                                disabled={busy}
                                className={button}
                                onClick={() =>
                                    void act(async (value) => {
                                        await value.off(true);
                                        if (!value.current()) return;
                                        setScore(null);
                                        setProposal(null);
                                        setMessage(
                                            'The Pi confirmed logging off and private scorecard evidence cleared.',
                                        );
                                    })
                                }
                            >
                                Stop and clear private evidence
                            </button>
                        </div>
                    )}
                    {message && (
                        <p role="status" aria-live="polite">
                            {message}
                        </p>
                    )}
                    {score && (
                        <div className="space-y-3">
                            <p>
                                {score.logging ? 'Logging consent is on.' : 'Logging is off.'} {score.phase}
                            </p>
                            <p>
                                Last measured:{' '}
                                {score.lastMeasuredAt === null
                                    ? 'none retained'
                                    : new Date(score.lastMeasuredAt).toISOString().replace('T', ' ').slice(0, 16) +
                                      ' UTC'}
                            </p>
                            <label className="block">
                                Private wind forecast lead
                                <select
                                    aria-label="Private wind forecast lead"
                                    className="mt-1 min-h-11 w-full rounded-lg border border-white/15 px-2"
                                    style={{ colorScheme: 'dark', backgroundColor: '#0f172a', color: '#e2e8f0' }}
                                    value={lead}
                                    onChange={(e) => setLead(e.target.value as SkillLead)}
                                >
                                    {SKILL_LEADS.map((v) => (
                                        <option key={v} value={v}>
                                            {v.replace('h', ' h')}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            {currentScore?.status === 'ready' ? (
                                <>
                                    <p className="font-semibold text-emerald-200">
                                        {currentScore.closest
                                            ? 'Closest to these instruments: ' + issuedModelLabel(currentScore.closest)
                                            : 'Closest to these instruments: tied'}
                                    </p>
                                    {Object.entries(currentScore.models)
                                        .filter(([, v]) => v.status === 'ready')
                                        .map(([model, value]) => (
                                            <p key={model}>
                                                {issuedModelLabel(model)} · MAE {value.mae!.toFixed(2)} m/s ·{' '}
                                                {value.pairs} paired hours · effective N {value.effectiveN}
                                            </p>
                                        ))}
                                </>
                            ) : (
                                <p>
                                    Warming. No score or closest model yet: two comparable models, 30 effective paired
                                    hours and ten days are required.
                                </p>
                            )}
                        </div>
                    )}
                </div>
            )}
        </details>
    );
}
