import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../index.css';
if (!import.meta.env.DEV) throw Error('Development fixture only');
document.documentElement.style.fontSize = '20.8px';
const [{ TracerPinEditor }, { useTraceDraft }, { setAuthIdentityScope }, { saveTrace, loadSavedTraces }] =
    await Promise.all([
        import('../../components/map/tracer/TracerPinEditor'),
        import('../../components/map/useTraceDraft'),
        import('../../services/authIdentityScope'),
        import('../../services/savedTraceStore'),
    ]);
setAuthIdentityScope(null);
function Fixture() {
    const draft = useTraceDraft();
    const [selected, setSelected] = React.useState<number | null>(1),
        [insert, setInsert] = React.useState<number | null>(null),
        [feedback, setFeedback] = React.useState('');
    const insertRef = React.useRef<number | null>(null);
    React.useEffect(() => {
        if (!draft.capturedCoords.length)
            draft.setCapturedCoords([
                { lat: 0, lon: 0 },
                { lat: 0, lon: 1 },
                { lat: 0, lon: 2 },
            ]);
        document.body.dataset.ready = 'true';
        // Initial synthetic pins only; account changes must stay empty.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return (
        <main className="min-h-dvh overflow-x-hidden bg-slate-950 p-2 text-white">
            <h1 className="mb-2 text-base font-bold">Synthetic Tracer pin choices</h1>
            {selected !== null && selected < draft.capturedCoords.length && (
                <TracerPinEditor
                    selectedPin={selected}
                    setSelectedPin={setSelected}
                    pinCount={draft.capturedCoords.length}
                    point={draft.capturedCoords[selected]}
                    previous={draft.capturedCoords[selected - 1]}
                    next={draft.capturedCoords[selected + 1]}
                    setCapturedCoords={draft.setCapturedCoords}
                    legAnchor={null}
                    insertAfter={insert}
                    setInsertAfter={setInsert}
                    insertAfterRef={insertRef}
                    flashTraceFeedback={setFeedback}
                />
            )}
            <p role="status" className="my-2 text-sm">
                {feedback}
            </p>
            <div className="flex flex-wrap gap-2">
                <button
                    className="min-h-[44px] rounded bg-sky-900 px-3"
                    onClick={() => {
                        const saved = saveTrace('Synthetic private marks', draft.capturedCoords);
                        setFeedback(saved.persisted ? 'Saved locally' : 'Local save refused');
                    }}
                >
                    Save local route
                </button>
                <button
                    className="min-h-[44px] rounded bg-sky-900 px-3"
                    onClick={() => {
                        draft.reverseDirection();
                        setSelected(1);
                    }}
                >
                    Reverse draft
                </button>
                <button
                    className="min-h-[44px] rounded bg-sky-900 px-3"
                    onClick={() => {
                        const saved = loadSavedTraces()[0];
                        if (saved) {
                            draft.setCapturedCoords(saved.points);
                            setSelected(1);
                        }
                    }}
                >
                    Restore saved route
                </button>
                <button
                    className="min-h-[44px] rounded bg-sky-900 px-3"
                    onClick={() => setAuthIdentityScope('fictional-tracer-other-account')}
                >
                    Change fixture account
                </button>
            </div>
            <output data-testid="point-intent" className="mt-2 block whitespace-pre-wrap break-all text-xs">
                {JSON.stringify(draft.capturedCoords)}
            </output>
            <p className="mt-2 text-xs text-gray-400">
                Development fixture: synthetic points, anonymous local storage, no charts, backend or safety-clearance
                claim.
            </p>
        </main>
    );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
