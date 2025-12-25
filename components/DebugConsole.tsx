
import React, { useState, useEffect, useRef } from 'react';
import { XIcon } from './Icons';
import { DebugInfo } from '../types';

interface DebugConsoleProps {
    isOpen: boolean;
    onClose: () => void;
    debugInfo?: DebugInfo;
}

export const DebugConsole: React.FC<DebugConsoleProps> = ({ isOpen, onClose, debugInfo }) => {
    const [activeTab, setActiveTab] = useState<'log' | 'json' | 'tide' | 'lifecycle'>('log');
    const logsEndRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (isOpen && logsEndRef.current) {
            logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [isOpen, debugInfo?.logs]);

    if (!isOpen) return null;

    const isPrecision = debugInfo?.logs.some(l => l.includes('Primary SG Success') || l.includes('Snap Point Failed')); // Loose check, better is to check modelUsed

    return (
        <div className="fixed inset-0 z-[110] bg-black text-green-500 font-mono text-xs flex flex-col">
            <div className="p-4 border-b border-green-800 flex justify-between items-center bg-gray-900">
                <div className="flex items-center gap-2">
                    <div className={`w-3 h-3 rounded-full animate-pulse ${isPrecision ? 'bg-purple-500' : 'bg-green-500'}`}></div>
                    <h2 className="text-sm font-bold uppercase tracking-widest">
                        System Diagnostics // {isPrecision ? 'PRECISION LOCK' : 'STANDARD FEED'}
                    </h2>
                </div>
                <button onClick={onClose} className="p-2 hover:bg-green-900/30 rounded text-green-500"><XIcon className="w-5 h-5"/></button>
            </div>

            <div className="flex border-b border-green-800 bg-black overflow-x-auto">
                <button onClick={() => setActiveTab('lifecycle')} className={`px-4 py-2 hover:bg-green-900/20 whitespace-nowrap ${activeTab === 'lifecycle' ? 'bg-green-900/40 text-white border-b-2 border-green-500' : ''}`}>Lifecycle</button>
                <button onClick={() => setActiveTab('log')} className={`px-4 py-2 hover:bg-green-900/20 whitespace-nowrap ${activeTab === 'log' ? 'bg-green-900/40 text-white' : ''}`}>Execution Log</button>
                <button onClick={() => setActiveTab('tide')} className={`px-4 py-2 hover:bg-green-900/20 whitespace-nowrap ${activeTab === 'tide' ? 'bg-green-900/40 text-white' : ''}`}>Grid Search</button>
                <button onClick={() => setActiveTab('json')} className={`px-4 py-2 hover:bg-green-900/20 whitespace-nowrap ${activeTab === 'json' ? 'bg-green-900/40 text-white' : ''}`}>Raw Data</button>
            </div>

            <div className="flex-1 overflow-auto p-4 custom-scrollbar">
                {!debugInfo ? (
                    <div className="text-center mt-20 opacity-50 uppercase tracking-widest">No diagnostic data // Initiate fetch</div>
                ) : (
                    <>
                        {activeTab === 'lifecycle' && (
                            <div className="space-y-4">
                                <h3 className="font-bold text-white border-b border-green-800 pb-2">Operational Lifecycle</h3>
                                {debugInfo.logs.filter(l => l.includes('PHASE') || l.includes('Sequence') || l.includes('Attempting') || l.includes('Parsed') || l.includes('Geocoded') || l.includes('FAST') || l.includes('Precision')).map((log, i) => (
                                    <div key={i} className="flex gap-3 items-start border-l-2 border-green-900 pl-4 py-1">
                                        <span className="text-[10px] bg-green-900/40 text-green-300 px-1.5 py-0.5 rounded font-bold">EVENT</span>
                                        <span className="text-white">{log}</span>
                                    </div>
                                ))}
                            </div>
                        )}

                        {activeTab === 'log' && (
                            <div className="space-y-1">
                                {debugInfo.logs.map((log, i) => (
                                    <div key={i} className="border-b border-green-900/30 pb-1 mb-1 break-words flex gap-2">
                                        <span className="opacity-40">[{i.toString().padStart(3, '0')}]</span>
                                        <span className={log.includes('ERROR') || log.includes('Failed') ? 'text-red-400' : log.includes('WARN') ? 'text-yellow-400' : 'text-green-400'}>{log}</span>
                                    </div>
                                ))}
                                <div ref={logsEndRef} />
                            </div>
                        )}

                        {activeTab === 'tide' && (
                            <div className="space-y-4">
                                <h3 className="font-bold text-white border-b border-green-800 pb-2">Coastal Grid Search Matrix</h3>
                                {debugInfo.attemptedLocations && debugInfo.attemptedLocations.length > 0 ? (
                                    <div className="space-y-2">
                                        {debugInfo.attemptedLocations.map((att, i) => (
                                            <div key={i} className={`p-2 rounded border bg-black/50 ${att.status === 'Success' ? 'border-green-500/50' : 'border-red-500/30'}`}>
                                                <div className="flex justify-between items-center">
                                                    <span className="font-bold text-white text-sm">{att.label}</span>
                                                    <span className={`text-xs font-bold uppercase px-2 py-0.5 rounded ${att.status === 'Success' ? 'bg-green-900 text-green-300' : att.status === 'Pending' ? 'bg-yellow-900 text-yellow-300' : 'bg-red-900 text-red-300'}`}>{att.status}</span>
                                                </div>
                                                <div className="opacity-50 text-[10px] mt-1 font-mono flex gap-4">
                                                    <span>LAT: {att.lat.toFixed(4)}</span>
                                                    <span>LON: {att.lon.toFixed(4)}</span>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                ) : <div className="opacity-40 italic border-l-2 border-red-500 pl-3">No grid search attempts recorded. Connection may have failed before matrix initialization.</div>}
                            </div>
                        )}

                        {activeTab === 'json' && (
                            <pre className="whitespace-pre-wrap break-all text-[10px] text-green-300 bg-black p-2 rounded">
                                {JSON.stringify(debugInfo.rawCurrent || debugInfo.finalLocation, null, 2)}
                            </pre>
                        )}
                    </>
                )}
            </div>
        </div>
    );
};
