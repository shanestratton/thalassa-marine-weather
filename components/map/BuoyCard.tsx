import React from 'react';
import { ModalSheet } from '../ui/ModalSheet';
import type { EvidenceStation, MeasuredBuoyDetail } from '../../services/weather/evidenceContract';
import { buoyAge, buoyGraph } from '../../services/weather/buoyPresentation';
import { issuedModelLabel } from '../../services/weather/nearbyEvidence';
import { openExternalUrl } from '../../services/externalLinks';
const COLORS = ['#fbbf24', '#c084fc', '#fb7185', '#a3e635'];
export default function BuoyCard({
    station,
    detail,
    message,
    onClose,
}: {
    station: EvidenceStation;
    detail: MeasuredBuoyDetail | null;
    message: string;
    onClose: () => void;
}) {
    const now = Date.now();
    const current = now < station.expiresAt * 1000;
    const graph = detail && current ? buoyGraph(detail, now) : null;
    const link = (event: React.MouseEvent<HTMLAnchorElement>) => {
        event.preventDefault();
        void openExternalUrl(event.currentTarget.href);
    };
    return (
        <ModalSheet
            isOpen
            onClose={onClose}
            title={station.label}
            maxWidth="max-w-md"
            zIndex="z-9998"
            fitViewport
            footer={
                <button
                    type="button"
                    aria-label="Close buoy"
                    onClick={onClose}
                    className="flex min-h-11 w-full items-center justify-center rounded-xl border border-white/15 bg-white/5 px-3 text-sm font-semibold text-white"
                >
                    Close
                </button>
            }
        >
            <div className="min-w-0 space-y-3 break-words pb-1 text-xs text-slate-300" data-testid="measured-buoy-card">
                <p className="font-semibold text-sky-200">
                    Measured significant wave height ·{' '}
                    {current ? `${station.hsM?.toFixed(1)} m · ${buoyAge(station.observedAt!, now)}` : 'expired'}
                </p>
                <p>
                    {station.qcBasis}.{' '}
                    {station.quality === 'provisional'
                        ? 'Provisional measurements are not scored as forecast truth.'
                        : 'Realtime screening is preliminary; this is not final scientific QC.'}
                </p>
                {message && <p role="status">{message}</p>}
                {graph && (
                    <>
                        <svg
                            className="block h-auto w-full"
                            viewBox="0 0 320 152"
                            role="img"
                            aria-label="72-hour measured waves and available forecasts captured before their valid hours, in metres"
                        >
                            <path d="M35 20V120H310M35 70H310" fill="none" stroke="#475569" strokeWidth="0.6" />
                            <text x="1" y="24" fill="#cbd5e1" fontSize="12">
                                {graph.top.toFixed(1)}
                            </text>
                            <text x="14" y="123" fill="#cbd5e1" fontSize="12">
                                0
                            </text>
                            <text x="35" y="145" fill="#cbd5e1" fontSize="12">
                                72 h ago
                            </text>
                            <text x="155" y="145" fill="#cbd5e1" fontSize="12">
                                36 h
                            </text>
                            <text x="284" y="145" fill="#cbd5e1" fontSize="12">
                                Now
                            </text>
                            {graph.issued.map((line, i) => (
                                <path
                                    key={line.model}
                                    d={line.path}
                                    fill="none"
                                    stroke={COLORS[i]}
                                    strokeWidth="3"
                                    strokeLinecap="round"
                                />
                            ))}
                            <path
                                d={graph.measured}
                                fill="none"
                                stroke="#22d3ee"
                                strokeWidth="2.5"
                                strokeLinecap="round"
                            />
                        </svg>
                        <p className="font-semibold text-cyan-300">Cyan dots: measured waves</p>
                        {graph.issued.map((line, i) => (
                            <p key={line.model} style={{ color: COLORS[i] }}>
                                {issuedModelLabel(line.model)} · original issued forecast, lead 0–6 h
                            </p>
                        ))}
                        {!graph.issued.length && (
                            <p>
                                No captured forecast history is available yet. Future forecasts only appear here after
                                their valid hour passes.
                            </p>
                        )}
                        <p>
                            Dots are original samples; gaps stay empty. This graph does not by itself measure model
                            skill. Nominal mooring position; open-sea conditions may differ from your boat.
                        </p>
                        <p>
                            Latest observation{' '}
                            {new Date(station.observedAt! * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC.
                            Original source received{' '}
                            {new Date(detail!.receivedAt * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC.
                        </p>
                    </>
                )}
                <div className="grid grid-cols-2 gap-2">
                    <a
                        href={station.sourceUrl}
                        onClick={link}
                        className="flex min-h-11 items-center justify-center rounded-lg border border-white/15 px-2 text-sky-200 underline"
                    >
                        Source data
                    </a>
                    <a
                        href={station.licenceUrl}
                        onClick={link}
                        className="flex min-h-11 items-center justify-center rounded-lg border border-white/15 px-2 text-sky-200 underline"
                    >
                        Source terms
                    </a>
                </div>
            </div>
        </ModalSheet>
    );
}
