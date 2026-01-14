
// src/components/DepthDisplay.tsx
import React, { useEffect, useState } from 'react';
import { fetchLiveTideDepth, TideResult } from '../services/worldTides';

interface Props {
    lat: number;
    lon: number;
}

export const DepthDisplay: React.FC<Props> = ({ lat, lon }) => {
    const [tide, setTide] = useState<TideResult | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const getData = async () => {
            setLoading(true);
            const result = await fetchLiveTideDepth(lat, lon);
            setTide(result);
            setLoading(false);
        };
        getData();
    }, [lat, lon]);

    if (loading) return <div>Loading Official Hydrographic Data...</div>;

    if (!tide || !tide.isSafe) {
        return (
            <div className="p-4 bg-red-600 text-white rounded-lg border-2 border-red-800 shadow-xl">
                <h3 className="font-bold text-lg uppercase">⚠️ NAVIGATION WARNING</h3>
                <p className="text-sm">Cannot confirm Safe Chart Datum.</p>
                <p className="text-xs mt-1 opacity-80">
                    Error: {tide?.error || "Unknown Failure"} (Datum: {tide?.datum})
                </p>
            </div>
        );
    }

    // THE GREEN LIGHT: We have verified LAT data
    return (
        <div className="p-4 bg-slate-800 text-white rounded-lg border border-slate-600">
            <div className="text-gray-400 text-xs uppercase tracking-wider">Tide Height</div>
            <div className="flex items-baseline">
                <span className="text-4xl font-mono font-bold text-blue-400">
                    {tide.height.toFixed(2)}m
                </span>
                <span className="ml-2 text-sm font-bold bg-blue-900 px-2 py-1 rounded text-blue-100">
                    {tide.datum}
                </span>
            </div>
            <div className="mt-2 text-xs text-gray-500">
                Station: {tide.stationName} <br />
                Synced: {new Date(tide.timestamp * 1000).toLocaleTimeString()}
            </div>
        </div>
    );
};
