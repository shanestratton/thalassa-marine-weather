import { useEffect, useState, type ReactNode } from 'react';
import { aisCoverageText, useAisCoverage } from '../../services/ais/aisCoverage';
import { openExternalUrl } from '../../services/externalLinks';
export function AisCoverageNotice({ compact = false }: { compact?: boolean }) {
    const coverage = useAisCoverage(),
        [now, setNow] = useState(Date.now);
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 30000);
        return () => clearInterval(timer);
    }, []);
    const credit = coverage.state !== 'unknown' && coverage.state !== 'held';
    const link = (children: ReactNode) => (
        <a
            href="https://www.aishub.net"
            onClick={(event) => {
                event.preventDefault();
                void openExternalUrl('https://www.aishub.net');
            }}
            className="inline-flex min-h-[44px] flex-col justify-center underline"
        >
            {children}
        </a>
    );
    if (compact)
        return (
            <div
                data-map-credit
                data-ais-internet-credit
                className="rounded-lg bg-slate-950/90 px-2 text-center text-[10px] leading-tight text-slate-200"
                title="Internet AIS is informational, delayed and incomplete. Do not use for navigation."
            >
                {credit ? (
                    link(
                        <>
                            <span>Data: AISHub contributors</span>
                            <span>{aisCoverageText(coverage, now, true)}</span>
                        </>,
                    )
                ) : (
                    <p className="py-1">{aisCoverageText(coverage, now, true)}</p>
                )}
            </div>
        );
    return (
        <div className="space-y-1 text-[11px] leading-snug text-slate-300" data-ais-internet-credit>
            <p>{aisCoverageText(coverage, now)}</p>
            <p>
                Internet reports are informational, delayed and incomplete. Do not use for navigation. No internet
                distress siren.
            </p>
            {credit && link('Data: AISHub contributors')}
        </div>
    );
}
