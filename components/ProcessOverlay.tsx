import React from 'react';

export const ProcessOverlay: React.FC<{ message?: string }> = ({ message = "Updating..." }) => {
    return (
        <div className="fixed inset-0 z-[2000] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center animate-in fade-in duration-300">
            <div className="bg-slate-950/80 backdrop-blur-md border border-white/10 rounded-2xl p-6 shadow-2xl flex flex-col items-center gap-4 min-w-[200px]">
                <div className="w-8 h-8 border-4 border-sky-500 border-t-transparent rounded-full animate-spin"></div>
                <span className="text-white font-bold text-xs tracking-widest uppercase animate-pulse">{message}</span>
            </div>
        </div>
    );
};
