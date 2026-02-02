
import React, { useState, useEffect } from 'react';
import { WindIcon, RainIcon, CompassIcon, BoatIcon, XIcon } from '../Icons';
import { fetchStopDetails } from '../../services/geminiService';
import { Waypoint, StopDetails, ObservationStation } from '../../types';

export type MapLayer = 'wind' | 'rain' | 'global-wind';

export const MapLegend = ({ layer }: { layer: MapLayer }) => {
    if (layer === 'wind') {
        return (
            <div className="absolute bottom-32 right-6 z-[800] bg-slate-900/95 backdrop-blur-md border-2 border-white/30 p-4 rounded-2xl shadow-2xl pointer-events-none select-none">
                <div className="text-xs font-bold text-white uppercase mb-3 flex items-center gap-2">
                    <WindIcon className="w-4 h-4 text-sky-400" /> Wind Speed (kts)
                </div>
                <div className="flex flex-col gap-2">
                    {/* UPDATED: Match new enhanced color palette */}
                    <div className="flex items-center gap-3 text-xs text-white font-mono">
                        <span className="w-4 h-4 rounded-full bg-[rgb(217,70,239)] shadow-[0_0_8px_rgba(217,70,239,0.9)] border border-fuchsia-300/50"></span>
                        <span className="font-bold">45+</span>
                        <span className="text-gray-300 ml-auto">Storm</span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-white font-mono">
                        <span className="w-4 h-4 rounded-full bg-[rgb(239,68,68)] shadow-[0_0_8px_rgba(239,68,68,0.9)] border border-red-300/50"></span>
                        <span className="font-bold">35-45</span>
                        <span className="text-gray-300 ml-auto">Gale</span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-white font-mono">
                        <span className="w-4 h-4 rounded-full bg-[rgb(249,115,22)] shadow-[0_0_6px_rgba(249,115,22,0.8)]"></span>
                        <span className="font-bold">25-35</span>
                        <span className="text-gray-300 ml-auto">Fresh</span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-white font-mono">
                        <span className="w-4 h-4 rounded-full bg-[rgb(234,179,8)] shadow-[0_0_6px_rgba(234,179,8,0.8)]"></span>
                        <span className="font-bold">15-25</span>
                        <span className="text-gray-300 ml-auto">Mod</span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-white font-mono">
                        <span className="w-4 h-4 rounded-full bg-[rgb(16,185,129)] shadow-[0_0_6px_rgba(16,185,129,0.8)]"></span>
                        <span className="font-bold">8-15</span>
                        <span className="text-gray-300 ml-auto">Light</span>
                    </div>
                    <div className="flex items- center gap-3 text-xs text-white font-mono">
                        <span className="w-4 h-4 rounded-full bg-[rgb(59,130,246)] shadow-[0_0_6px_rgba(59,130,246,0.8)]"></span>
                        <span className="font-bold">3-8</span>
                        <span className="text-gray-300 ml-auto">Gentle</span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-white font-mono">
                        <span className="w-4 h-4 rounded-full bg-[rgb(200,200,200)] shadow-[0_0_4px_rgba(200,200,200,0.6)]"></span>
                        <span className="font-bold">0-3</span>
                        <span className="text-gray-300 ml-auto">Calm</span>
                    </div>
                </div>
            </div>
        );
    }
    if (layer === 'rain') {
        return (
            <div className="absolute bottom-32 right-6 z-[800] bg-slate-900/95 backdrop-blur-md border-2 border-white/30 p-4 rounded-2xl shadow-2xl pointer-events-none select-none">
                <div className="text-xs font-bold text-white uppercase mb-3 flex items-center gap-2">
                    <RainIcon className="w-4 h-4 text-blue-400" /> Precipitation
                </div>
                <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-3 text-xs text-white font-mono">
                        <span className="w-4 h-4 rounded-full bg-[rgb(59,130,246)] shadow-[0_0_10px_rgba(59,130,246,0.9)] border border-blue-300/50"></span>
                        <span className="font-bold">Heavy</span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-white font-mono">
                        <span className="w-4 h-4 rounded-full bg-[rgb(96,165,250)] opacity-60 shadow-[0_0_6px_rgba(96,165,250,0.6)]"></span>
                        <span className="font-bold">Light</span>
                    </div>
                </div>
            </div>
        );
    }
    if (layer === 'global-wind') {
        return (
            <div className="absolute bottom-32 right-6 z-[800] bg-slate-900/95 backdrop-blur-md border-2 border-white/30 p-4 rounded-2xl shadow-2xl pointer-events-none select-none">
                <div className="text-xs font-bold text-white uppercase mb-3 flex items-center gap-2">
                    <WindIcon className="w-4 h-4 text-sky-400" /> Global Winds
                </div>
                <div className="flex flex-col gap-2">
                    <div className="text-[10px] text-gray-400 mb-1">Streamlines</div>
                    <div className="flex items-center gap-3 text-xs text-white font-mono">
                        <div className="w-4 h-1 bg-[rgb(239,68,68)] rounded shadow-[0_0_6px_rgba(239,68,68,0.8)]"></div>
                        <span className="font-bold">60+ kts</span>
                        <span className="text-gray-300 ml-auto">Jet</span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-white font-mono">
                        <div className="w-4 h-1 bg-[rgb(249,115,22)] rounded shadow-[0_0_5px_rgba(249,115,22,0.7)]"></div>
                        <span className="font-bold">30-60</span>
                        <span className="text-gray-300 ml-auto">Strong</span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-white font-mono">
                        <div className="w-4 h-1 bg-[rgb(234,179,8)] rounded shadow-[0_0_5px_rgba(234,179,8,0.7)]"></div>
                        <span className="font-bold">20-30</span>
                        <span className="text-gray-300 ml-auto">Mod</span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-white font-mono">
                        <div className="w-4 h-1 bg-[rgb(59,130,246)] opacity-60 rounded shadow-[0_0_4px_rgba(59,130,246,0.6)]"></div>
                        <span className="font-bold">0-20</span>
                        <span className="text-gray-300 ml-auto">Light</span>
                    </div>
                    <div className="border-t border-white/10 my-2"></div>
                    <div className="text-[10px] text-gray-400 mb-1">Pressure</div>
                    <div className="flex items-center gap-3 text-xs text-white font-mono">
                        <span className="w-4 h-4 rounded-full border-2 border-red-500 flex items-center justify-center text-[8px] font-bold text-red-500">H</span>
                        <span className="text-gray-300">High</span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-white font-mono">
                        <span className="w-4 h-4 rounded-full border-2 border-blue-500 flex items-center justify-center text-[8px] font-bold text-blue-500">L</span>
                        <span className="text-gray-300">Low</span>
                    </div>
                </div>
            </div>
        );
    }
    return null;
};

export const StopDetailView = ({ waypoint, onClose }: { waypoint: Waypoint, onClose: () => void }) => {
    const [details, setDetails] = useState<StopDetails | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        setLoading(true);
        fetchStopDetails(waypoint.name).then(res => {
            setDetails(res);
            setLoading(false);
        }).catch(() => setLoading(false));
    }, [waypoint.name]);

    return (
        <div className="absolute inset-0 z-[1100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-300" onClick={onClose}>
            <div
                className="w-full max-w-md bg-[#0f172a] border border-white/10 rounded-3xl shadow-2xl overflow-hidden relative flex flex-col max-h-[80vh]"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="h-32 bg-slate-800 relative">
                    {details && (
                        <div
                            className="absolute inset-0 bg-cover bg-center opacity-60"
                            style={{ backgroundImage: `url(https://source.unsplash.com/featured/?marina,sea,${encodeURIComponent(details.imageKeyword || waypoint.name)})` }}
                        ></div>
                    )}
                    <div className="absolute inset-0 bg-gradient-to-t from-[#0f172a] to-transparent"></div>
                    <button onClick={onClose} className="absolute top-4 right-4 p-2 bg-black/30 hover:bg-black/50 rounded-full text-white transition-colors backdrop-blur-md">
                        <XIcon className="w-5 h-5" />
                    </button>
                    <div className="absolute bottom-4 left-6">
                        <h2 className="text-2xl font-bold text-white shadow-black drop-shadow-md leading-tight">{waypoint.name}</h2>
                        {waypoint.coordinates && <p className="text-xs text-sky-300 font-mono drop-shadow-md">{waypoint.coordinates.lat.toFixed(3)}°N, {Math.abs(waypoint.coordinates.lon).toFixed(3)}°W</p>}
                    </div>
                </div>

                <div className="p-6 overflow-y-auto custom-scrollbar flex-1">
                    {loading ? (
                        <div className="flex flex-col items-center justify-center h-40 gap-4">
                            <div className="w-8 h-8 border-2 border-sky-500 border-t-transparent rounded-full animate-spin"></div>
                            <span className="text-xs text-gray-400 animate-pulse">Retrieving Location Details...</span>
                        </div>
                    ) : details ? (
                        <div className="space-y-6">
                            <p className="text-sm text-gray-300 leading-relaxed font-light">{details.overview}</p>

                            <div className="space-y-3">
                                <div className="flex justify-between items-center">
                                    <h4 className="text-xs font-bold text-white uppercase tracking-widest flex items-center gap-2">
                                        <CompassIcon rotation={0} className="w-4 h-4 text-sky-400" /> Navigation
                                    </h4>
                                </div>
                                <div className="bg-slate-900/50 border border-white/5 rounded-xl p-3">
                                    <p className="text-xs text-gray-400 leading-relaxed">{details.navigationNotes}</p>
                                </div>
                            </div>

                            <div className="space-y-3">
                                <h4 className="text-xs font-bold text-white uppercase tracking-widest flex items-center gap-2">
                                    <BoatIcon className="w-4 h-4 text-sky-400" /> Facilities
                                </h4>
                                <div className="flex flex-wrap gap-2">
                                    {details.fuelAvailable && <span className="px-2 py-1 rounded bg-orange-500/10 text-orange-300 text-[10px] font-bold border border-orange-500/20">FUEL DOCK</span>}
                                    {details.marinaFacilities?.slice(0, 6).map((f, i) => (
                                        <span key={i} className="px-2 py-1 rounded bg-white/5 text-gray-300 text-[10px] font-medium border border-white/10">{f}</span>
                                    ))}
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div className="text-center text-gray-500 text-xs">Details unavailable.</div>
                    )}
                </div>
            </div>
        </div>
    );
};
