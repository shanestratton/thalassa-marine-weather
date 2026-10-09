/** Production helm and modal with local state only; no map, account or feed access. */
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RadialHelmMenu } from '../../components/map/RadialHelmMenu';
import type { WeatherLayer } from '../../components/map/mapConstants';
import { ModalSheet } from '../../components/ui/ModalSheet';
import { OverlayPortal } from '../../components/ui/OverlayPortal';
import '../../index.css';

function Fixture() {
    const [activeLayers, setActiveLayers] = useState<Set<WeatherLayer>>(new Set());
    const [ais, setAis] = useState(false);
    const [tides, setTides] = useState(false);
    const [routes, setRoutes] = useState(false);
    const [mobOpens, setMobOpens] = useState(0);
    const [modalOpen, setModalOpen] = useState(false);
    const [modalKind, setModalKind] = useState<'app' | 'chart'>('app');
    const closeModal = () => {
        setModalOpen(false);
        setModalKind('chart');
    };
    const [overlayClicks, setOverlayClicks] = useState(0);
    const toggleLayer = (layer: WeatherLayer) =>
        setActiveLayers((previous) => {
            const next = new Set(previous);
            if (layer === 'none') return new Set();
            if (next.has(layer)) next.delete(layer);
            else next.add(layer);
            return next;
        });

    return (
        <main
            className="relative isolate h-dvh w-full overflow-hidden bg-slate-950 text-white"
            data-testid="helm-fixture"
            data-ais={String(ais)}
            data-tides={String(tides)}
            data-wind={String(activeLayers.has('wind'))}
            data-routes={String(routes)}
            data-mob-opens={mobOpens}
            data-overlay-clicks={overlayClicks}
        >
            {/* Opaque and pointer-intercepting siblings cover every menu slot.
                The highest chart popup subsumes the two lower stacking bands. */}
            {[
                { id: 'storm-card', zIndex: 760, color: '#263344' },
                { id: 'tracer-card', zIndex: 9995, color: '#233c50' },
                { id: 'chart-popup', zIndex: 10000, color: '#2d4660' },
            ].map((overlay) => (
                <div
                    key={overlay.id}
                    data-testid={overlay.id}
                    className="absolute inset-0"
                    style={{ zIndex: overlay.zIndex, background: overlay.color }}
                    onClick={() => setOverlayClicks((count) => count + 1)}
                />
            ))}
            <RadialHelmMenu
                activeLayers={activeLayers}
                toggleLayer={toggleLayer}
                selectInGroup={(layer, group) =>
                    setActiveLayers((previous) => {
                        const next = new Set(previous);
                        group.forEach((member) => next.delete(member));
                        next.add(layer);
                        return next;
                    })
                }
                tacticalState={{
                    onOpenMob: () => setMobOpens((count) => count + 1),
                    aisVisible: ais,
                    onToggleAis: () => setAis((value) => !value),
                    tideStationsVisible: tides,
                    onToggleTideStations: () => setTides((value) => !value),
                }}
                chartsState={{
                    sources: [
                        {
                            id: 'routes',
                            label: 'Routes',
                            iconKind: 'generic',
                            enabled: routes,
                            onToggle: () => setRoutes((value) => !value),
                            onClear: () => setRoutes(false),
                            opensSheet: true,
                        },
                    ],
                }}
            />
            {/* Above the chart's scrim but inside its isolated stacking root.
                Both actual portal components escape that root into the body. */}
            <button
                type="button"
                className="fixed left-3 top-3 z-[10040] min-h-11 rounded-lg bg-slate-900 px-3"
                onClick={() => setModalOpen(true)}
            >
                Open blocking modal
            </button>
            {modalOpen && modalKind === 'app' && (
                <OverlayPortal
                    layer="modal"
                    role="dialog"
                    aria-modal="true"
                    aria-label="App modal"
                    className="flex items-center justify-center bg-black/60 p-4 text-white"
                >
                    <section className="rounded-2xl bg-slate-900 p-5">
                        <p>App modal above the isolated chart.</p>
                        <button type="button" className="min-h-[44px] min-w-[44px] px-4" onClick={closeModal}>
                            Close
                        </button>
                    </section>
                </OverlayPortal>
            )}
            <ModalSheet
                isOpen={modalOpen && modalKind === 'chart'}
                onClose={closeModal}
                title="Chart modal"
                zIndex="z-[10050]"
            >
                <p>Blocking chart action stays above the open layer menu.</p>
            </ModalSheet>
        </main>
    );
}

// Stacking is independent of motion: browser-tests/helm-stacking.spec.ts runs
// this page with prefers-reduced-motion, so the menu's CSS entrances and exits
// are off and no click waits on a moving target.
createRoot(document.getElementById('root')!).render(<Fixture />);
