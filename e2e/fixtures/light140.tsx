/** Fictional source tags and coordinates; real production popup renderers.
 * No map, network provider, chart, navigation, vessel or hardware input. */
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SeamarkPopup } from '../../components/map/SeamarkPopup';
import { buildFeaturePopupHtml } from '../../components/map/encPopup';
import { ENC_VEC_LAYERS } from '../../components/map/encLayerIds';
if (!import.meta.env.DEV) throw Error('Development-only fictional fixture.');

function Fixture() {
    const [open, setOpen] = useState<'enc' | 'osm' | 'unknown' | null>(null);
    return (
        <main>
            <h1>Fictional light popups</h1>
            <p>Production popup components with invented attributes.</p>
            <nav>
                {(['enc', 'osm', 'unknown'] as const).map((kind) => (
                    <button key={kind} onClick={() => setOpen(kind)}>
                        Open {kind}
                    </button>
                ))}
                <button onClick={() => setOpen(null)}>Close preview</button>
            </nav>
            {open && (
                <section aria-label="Fictional popup" style={{ margin: '24px 18px', maxWidth: '280px' }}>
                    {open === 'osm' ? (
                        <SeamarkPopup
                            seamarkType="light_minor"
                            name="Fictional green light"
                            coordinates={[0, 0]}
                            tags={{ 'light:1:character': 'Iso', 'light:1:period': '4', 'light:1:colour': 'green' }}
                        />
                    ) : (
                        <div
                            dangerouslySetInnerHTML={{
                                __html: buildFeaturePopupHtml(ENC_VEC_LAYERS.LIGHTS, {
                                    OBJNAM: 'Fictional red light',
                                    LITCHR: 2,
                                    COLOUR: open === 'unknown' ? '1,3' : 3,
                                    SIGPER: 10,
                                    SIGGRP: '(2)',
                                    SIGSEQ: '0.3+(1.7)+0.3+(7.7)',
                                }),
                            }}
                        />
                    )}
                </section>
            )}
        </main>
    );
}
document.head.insertAdjacentHTML(
    'beforeend',
    '<style>html{color-scheme:dark}body{margin:0;background:#020617;color:#e2e8f0;font-family:system-ui}main>h1,main>p{margin:12px;font-size:1rem}nav{display:flex;flex-wrap:wrap;padding:8px;gap:4px}nav button{min-height:44px;padding:4px 8px}*{box-sizing:border-box}</style>',
);
createRoot(document.getElementById('root')!).render(<Fixture />);
