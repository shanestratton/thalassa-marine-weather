/**
 * "Keep your distance": the legal approach distances, shown the moment a
 * whale or dolphin is logged. Amber because it is a legal warning, the only
 * amber in Sightings.
 *
 * Every number comes from services/sightings/approachRules.ts, read from the
 * Queensland Government and GBRMPA pages on 2026-10-05 and linked here.
 * Outside Queensland and the Marine Park, or with no position yet, the card
 * gives no number: keep your distance, check the local rules, and the
 * national guidelines' link.
 */
import React, { useState } from 'react';
import type { DistanceCard } from '../../services/sightings/approachRules';

async function openSource(url: string) {
    const { openExternalUrl } = await import('../../services/externalLinks');
    await openExternalUrl(url);
}

const SHORT_SOURCE: Record<string, string> = {
    'www.qld.gov.au': 'qld.gov.au',
    'www.gbrmpa.gov.au': 'gbrmpa.gov.au',
    'www.dcceew.gov.au': 'dcceew.gov.au',
};

function shortSource(url: string): string {
    try {
        const host = new URL(url).host;
        return SHORT_SOURCE[host] ?? host;
    } catch {
        return url;
    }
}

/** Rows shown before "more": the boat, the calf and the speed lines come first in every card. */
const FIRST_ROWS = 4;

export const KeepYourDistanceCard: React.FC<{ card: DistanceCard; hasCalf: boolean }> = ({ card, hasCalf }) => {
    const [all, setAll] = useState(false);
    const rows = card.kind === 'rules' ? (all ? card.rows : card.rows.slice(0, FIRST_ROWS)) : [];
    const hidden = card.kind === 'rules' ? card.rows.length - rows.length : 0;
    // "Queensland & Marine Park rules · checked 5 Oct 2026" → "checked 5 Oct 2026".
    const checked = card.kind === 'rules' ? card.footer.split(' · ').pop() : null;
    return (
        <section aria-labelledby="sg-distance-title" className="sg-amber px-3 pt-2.5 pb-2" data-testid="distance-card">
            <div className="flex flex-wrap items-baseline justify-between gap-x-2 px-0.5">
                <h3 id="sg-distance-title" className="whitespace-nowrap text-[15px] font-black sg-amber-strong">
                    Keep your distance
                </h3>
                {card.kind === 'rules' && (
                    <span className="whitespace-nowrap text-[11px] font-bold opacity-90">
                        QLD &amp; Marine Park rules
                    </span>
                )}
            </div>
            {card.kind === 'rules' ? (
                <ul className="mt-1.5 grid grid-cols-2 gap-x-1.5 gap-y-1">
                    {rows.map((row, i) => (
                        <li
                            key={`${row.value}-${i}`}
                            className={`rounded-[10px] px-2 py-1.5 ${row.calf && hasCalf ? 'sg-amber-hi' : ''}`}
                            data-calf={row.calf && hasCalf ? 'lit' : undefined}
                        >
                            <span className="block text-[18px] font-black leading-none tabular-nums sg-amber-strong">
                                {row.value}
                            </span>
                            <span className="mt-0.5 block text-[11.5px] leading-snug">{row.text}</span>
                        </li>
                    ))}
                </ul>
            ) : (
                <p className="mt-1 px-0.5 text-[13px] leading-snug">{card.text}</p>
            )}
            <div className="mt-0.5 flex flex-wrap items-center gap-x-1 px-0.5 text-[11.5px]">
                {hidden > 0 && (
                    <button
                        type="button"
                        onClick={() => setAll(true)}
                        className="mr-1 min-h-[44px] font-extrabold sg-amber-strong"
                    >
                        {hidden} more {hidden === 1 ? 'rule' : 'rules'}
                    </button>
                )}
                <span>{card.kind === 'rules' ? 'Sources:' : 'Guidelines:'}</span>
                {card.sources.map((source, i) => (
                    <React.Fragment key={source.url}>
                        {i > 0 && <span aria-hidden="true">·</span>}
                        <button
                            type="button"
                            onClick={() => void openSource(source.url)}
                            aria-label={`Open ${source.label}`}
                            className="sg-link"
                        >
                            {shortSource(source.url)}
                        </button>
                    </React.Fragment>
                ))}
                {checked && <span className="ml-auto opacity-80">{checked}</span>}
            </div>
        </section>
    );
};
