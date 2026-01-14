import React from 'react';
import { AlertTriangleIcon, ChevronLeftIcon } from './Icons';
import { useUI } from '../context/UIContext';

interface WarningDetailsProps {
    alerts: string[];
}

export const WarningDetails: React.FC<WarningDetailsProps> = ({ alerts }) => {
    const { setPage } = useUI();

    return (
        <div className="flex flex-col h-full bg-slate-900 text-white animate-in fade-in slide-in-from-right-4 duration-300">
            {/* Header */}
            <div className="flex items-center gap-2 p-4 pt-[max(1rem,env(safe-area-inset-top))] bg-slate-900 border-b border-white/10 shrink-0">
                <button
                    onClick={() => setPage('dashboard')}
                    className="p-2 -ml-2 rounded-full hover:bg-white/10 active:bg-white/20 transition-colors"
                >
                    <ChevronLeftIcon className="w-6 h-6 text-sky-400" />
                </button>
                <div className="flex items-center gap-2">
                    <AlertTriangleIcon className="w-5 h-5 text-red-500" />
                    <h2 className="text-lg font-bold uppercase tracking-wider">Active Warnings</h2>
                </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {alerts && alerts.length > 0 ? (
                    alerts.map((alert, index) => (
                        <div key={index} className="bg-red-500/10 border border-red-500/20 rounded-2xl p-5 shadow-lg relative overflow-hidden">
                            <div className="absolute top-0 right-0 p-3 opacity-10">
                                <AlertTriangleIcon className="w-24 h-24 text-red-500" />
                            </div>
                            <div className="relative z-10">
                                <span className="inline-block bg-red-500 text-white text-[10px] font-bold px-2 py-0.5 rounded-full mb-3 uppercase tracking-wider">
                                    Warning {index + 1}
                                </span>
                                <p className="text-lg font-medium text-red-100 leading-relaxed">
                                    {alert}
                                </p>
                            </div>
                        </div>
                    ))
                ) : (
                    <div className="flex flex-col items-center justify-center h-full opacity-50 pb-20">
                        <div className="bg-white/5 p-6 rounded-full mb-4">
                            <AlertTriangleIcon className="w-12 h-12 text-gray-400" />
                        </div>
                        <p className="text-gray-400 font-medium">No active warnings.</p>
                    </div>
                )}
            </div>
        </div>
    );
};
