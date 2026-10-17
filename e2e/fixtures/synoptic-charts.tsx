/** Synthetic chart only: exercises layout and pinch/fit offline without downloading official media. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../index.css';
if (!import.meta.env.DEV) throw new Error('Development fixture only');
const params = new URLSearchParams(location.search);
if (params.has('largeText')) document.documentElement.style.fontSize = '24px';
const canvas = document.createElement('canvas');
canvas.width = 800;
canvas.height = 1200;
const ctx = canvas.getContext('2d')!;
ctx.fillStyle = '#fff';
ctx.fillRect(0, 0, 800, 1200);
ctx.fillStyle = '#123';
ctx.font = 'bold 32px sans-serif';
ctx.fillText('SYNTHETIC CHART FIXTURE', 70, 80);
ctx.fillText('VALID TIME ON CHART', 90, 1140);
for (let y = 160; y < 1000; y += 100) {
    ctx.beginPath();
    ctx.moveTo(40, y);
    ctx.bezierCurveTo(250, y - 90, 500, y + 100, 760, y);
    ctx.stroke();
}
const dataUrl = canvas.toDataURL('image/png');
localStorage.setItem(
    'thalassa_synoptic_charts_v1',
    JSON.stringify([
        { id: 'jma-analysis', dataUrl, downloadedAt: Date.now() - 120000, bytes: atob(dataUrl.split(',')[1]).length },
    ]),
);
const [{ SynopticChartSheet }, { useSettingsStore }] = await Promise.all([
    import('../../components/map/SynopticChartSheet'),
    import('../../stores/settingsStore'),
]);
useSettingsStore.setState((state) => ({ settings: { ...state.settings, satelliteMode: true } }));
createRoot(document.getElementById('root')!).render(
    <SynopticChartSheet
        point={params.has('south') ? { lat: -37, lon: 174 } : { lat: 35, lon: 140 }}
        onClose={() => {
            document.documentElement.dataset.closed = 'true';
        }}
    />,
);
