import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import ClimateRoseCard from '../../components/passage/ClimateRoseCard';
import { ModalSheet } from '../../components/ui/ModalSheet';
import { climateCellFixture } from '../../tests/fixtures/climate142';
import { climateTileKey } from '../../services/climatology/era5Climate';
import '../../index.css';
if (!import.meta.env.DEV) throw new Error('Development fixture only');
document.documentElement.style.fontSize = new URLSearchParams(location.search).get('scale') === '130' ? '130%' : '100%';
document.body.style.cssText = 'height:100dvh;overflow:hidden;margin:0';
document.getElementById('root')!.style.height = '100%';
document.documentElement.dataset.climateReads = '0';
const generation = 'a'.repeat(64),
    key = climateTileKey('-27,153');
const routeLegs = [
    {
        points: [
            { lat: -27, lon: 153 },
            { lat: -27, lon: 153.1 },
        ],
    },
];
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
async function start() {
    const cell = climateCellFixture();
    for (const row of cell.months) {
        row.windRose.fill(0);
        row.waveRose.fill(0);
        row.windRose[2] = row.windCount / 2;
        row.windRose[35] = row.windCount / 4;
        row.windRose[65] = row.windCount / 4;
        row.waveRose[1] = row.waveCount / 2;
        row.waveRose[50] = row.waveCount / 4;
        row.waveRose[99] = row.waveCount / 4;
    }
    const descriptor = async (data: Uint8Array) => ({
        bytes: data.length,
        sha256: [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))]
            .map((n) => n.toString(16).padStart(2, '0'))
            .join(''),
    });
    const tile = bytes({ schema: 1, generation, key, cells: [cell] });
    const manifest = bytes({
        schema: 1,
        kind: 'era5-climate',
        generation,
        firstYear: 1991,
        lastYear: 2020,
        gridDegrees: 1,
        originals: 720,
        dataset: 'reanalysis-era5-complete',
        licence: 'CC-BY-4.0',
        method: 'hourly-uv-swh-mwd-v1',
        originalCohortSha256: 'b'.repeat(64),
        generatedAt: '2026-10-17T00:00:00Z',
        tiles: { [key]: await descriptor(tile) },
    });
    const files = new Map([
        ['latest.json', bytes({ schema: 1, generation, manifest: await descriptor(manifest) })],
        [`${generation}/manifest.json`, manifest],
        [`${generation}/tile-${key}.json`, tile],
    ]);
    window.fetch = async (input) => {
        const path = String(input).split('/climate/era5-v1/')[1];
        if (files.has(path)) {
            document.documentElement.dataset.climateReads = String(
                Number(document.documentElement.dataset.climateReads) + 1,
            );
            return new Response(files.get(path) as BodyInit);
        }
        return new Response('Fictional fixture: external traffic disabled', { status: 503 });
    };
    function Fixture() {
        const [open, setOpen] = useState(true);
        return (
            <main className="h-full overflow-hidden bg-slate-950">
                <p className="text-xs text-white">Fictional climate; no CDS/native or public-data acceptance.</p>
                <ModalSheet
                    isOpen={open}
                    onClose={() => setOpen(false)}
                    title="Trip climate"
                    footer={
                        <button
                            className="min-h-[44px] w-full rounded-xl bg-slate-800 text-white"
                            onClick={() => setOpen(false)}
                        >
                            Close climate
                        </button>
                    }
                >
                    <p className="text-xs text-gray-300">Inside the existing trip scroll, beside seasonal risk.</p>
                    <ClimateRoseCard routeLegs={routeLegs} />
                </ModalSheet>
            </main>
        );
    }
    createRoot(document.getElementById('root')!).render(<Fixture />);
}
void start();
