import React from 'react';
import type { VoyageSummary } from '../../services/shiplog/VoyageSummary';

/** Preserve list order and individual log identity. Only known membership
 * groups cards; unrelated overnight voyages remain independent. */
export function groupPassageLogs(voyages: readonly VoyageSummary[]) {
    const groups: { key: string; passage: boolean; voyages: VoyageSummary[] }[] = [];
    const byPassage = new Map<string, (typeof groups)[number]>();
    for (const voyage of voyages) {
        const passageId = voyage.passageGroupId;
        if (!passageId) {
            groups.push({ key: `voyage:${voyage.voyageId}`, passage: false, voyages: [voyage] });
            continue;
        }
        let group = byPassage.get(passageId);
        if (!group) {
            group = { key: `passage:${passageId}`, passage: true, voyages: [] };
            byPassage.set(passageId, group);
            groups.push(group);
        }
        group.voyages.push(voyage);
    }
    return groups;
}

export function PassageLogList({
    voyages,
    renderVoyage,
}: {
    voyages: readonly VoyageSummary[];
    renderVoyage: (voyage: VoyageSummary, first: boolean) => React.ReactNode;
}) {
    return (
        <>
            {groupPassageLogs(voyages).map((group) => {
                const cards = group.voyages.map((voyage) => renderVoyage(voyage, voyage === voyages[0]));
                if (!group.passage) return <React.Fragment key={group.key}>{cards}</React.Fragment>;
                return (
                    <section
                        key={group.key}
                        aria-label={`Passage · ${group.voyages.length} ${group.voyages.length === 1 ? 'leg' : 'legs'}`}
                        className="mb-4 rounded-[1.75rem] border border-purple-400/40 bg-linear-to-b from-purple-500/15 via-purple-500/5 to-purple-500/10 p-2 shadow-[0_0_22px_-8px_rgba(192,132,252,0.45)]"
                    >
                        <div className="flex items-center justify-between gap-2 px-2 py-2.5">
                            <h3 className="text-xs font-extrabold tracking-[0.2em] text-yellow-300">PASSAGE</h3>
                            <span className="text-[11px] font-semibold text-purple-200/75">
                                {group.voyages.length} {group.voyages.length === 1 ? 'leg' : 'legs'}
                            </span>
                        </div>
                        <div className="[&>div:last-child]:mb-0">{cards}</div>
                    </section>
                );
            })}
        </>
    );
}
