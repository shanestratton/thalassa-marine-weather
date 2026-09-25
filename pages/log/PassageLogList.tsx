import React, { useState } from 'react';
import type { VoyageSummary } from '../../services/shiplog/VoyageSummary';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';

type ArchivePassage = (passageId: string, voyageIds: string[]) => Promise<void>;

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
    onArchivePassage,
    protectedVoyageIds = [],
}: {
    voyages: readonly VoyageSummary[];
    renderVoyage: (voyage: VoyageSummary, first: boolean) => React.ReactNode;
    onArchivePassage?: ArchivePassage;
    protectedVoyageIds?: readonly string[];
}) {
    const [archiveRequest, setArchiveRequest] = useState<{
        passageId: string;
        voyageIds: string[];
        archive: ArchivePassage;
    } | null>(null);
    const [archiving, setArchiving] = useState(false);
    const archiveBusy = React.useRef(false);
    const cancelArchive = () => {
        if (!archiveBusy.current) setArchiveRequest(null);
    };
    return (
        <>
            {groupPassageLogs(voyages).map((group) => {
                const cards = group.voyages.map((voyage) => renderVoyage(voyage, voyage === voyages[0]));
                if (!group.passage) return <React.Fragment key={group.key}>{cards}</React.Fragment>;
                const recording = group.voyages.some((voyage) => protectedVoyageIds.includes(voyage.voyageId));
                return (
                    <section
                        key={group.key}
                        aria-label={`Passage · ${group.voyages.length} ${group.voyages.length === 1 ? 'leg' : 'legs'}`}
                        className="mb-4 rounded-[1.75rem] border border-purple-400/40 bg-linear-to-b from-purple-500/15 via-purple-500/5 to-purple-500/10 p-2 shadow-[0_0_22px_-8px_rgba(192,132,252,0.45)]"
                    >
                        <div className="flex items-center justify-between gap-2 px-2 py-2.5">
                            <h3 className="text-xs font-extrabold tracking-[0.2em] text-yellow-300">PASSAGE</h3>
                            <div className="flex items-center gap-2">
                                <span className="text-[11px] font-semibold text-purple-200/75">
                                    {group.voyages.length} {group.voyages.length === 1 ? 'leg' : 'legs'}
                                </span>
                                {onArchivePassage && (
                                    <button
                                        type="button"
                                        disabled={archiving || recording}
                                        title={
                                            recording
                                                ? 'End the active voyage before archiving this passage'
                                                : undefined
                                        }
                                        onClick={() =>
                                            setArchiveRequest({
                                                passageId: group.voyages[0].passageGroupId!,
                                                voyageIds: group.voyages.map((voyage) => voyage.voyageId),
                                                // Keep the identity-bound handler from the moment of consent.
                                                // A new account must not inherit an old open confirmation.
                                                archive: onArchivePassage,
                                            })
                                        }
                                        className="min-h-[44px] rounded-xl border border-purple-300/25 bg-purple-400/10 px-3 text-xs font-bold text-purple-100 disabled:opacity-40"
                                    >
                                        Archive passage
                                    </button>
                                )}
                            </div>
                        </div>
                        {onArchivePassage && recording && (
                            <p className="px-2 pb-2 text-xs text-purple-200/80">
                                End the active voyage to archive this passage.
                            </p>
                        )}
                        <div className="[&>div:last-child]:mb-0">{cards}</div>
                    </section>
                );
            })}
            <ConfirmDialog
                isOpen={!!archiveRequest}
                title="Archive this passage?"
                message={`Move all ${archiveRequest?.voyageIds.length ?? 0} ${(archiveRequest?.voyageIds.length ?? 0) === 1 ? 'leg' : 'legs'} into Archived Voyages. Nothing is deleted; you can restore each leg there.`}
                confirmLabel={`Archive ${archiveRequest?.voyageIds.length ?? 0} ${(archiveRequest?.voyageIds.length ?? 0) === 1 ? 'leg' : 'legs'}`}
                onCancel={cancelArchive}
                onConfirm={async () => {
                    if (!archiveRequest || archiveBusy.current) return;
                    archiveBusy.current = true;
                    setArchiving(true);
                    try {
                        await archiveRequest.archive(archiveRequest.passageId, archiveRequest.voyageIds);
                    } finally {
                        archiveBusy.current = false;
                        setArchiving(false);
                        setArchiveRequest(null);
                    }
                }}
            />
        </>
    );
}
