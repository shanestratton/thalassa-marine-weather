import React, { useState, useEffect } from 'react';

interface DebugLog {
    timestamp: string;
    message: string;
    type: 'log' | 'warn' | 'error';
}

// Intercept console methods
const debugLogs: DebugLog[] = [];
const MAX_LOGS = 50;

const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

console.log = (...args: any[]) => {
    const msg = args.join(' ');
    if (msg.includes('[METAR]') || msg.includes('[DataSourceMerger]')) {
        debugLogs.push({
            timestamp: new Date().toLocaleTimeString(),
            message: msg,
            type: 'log'
        });
        if (debugLogs.length > MAX_LOGS) debugLogs.shift();
    }
    originalLog.apply(console, args);
};

console.warn = (...args: any[]) => {
    const msg = args.join(' ');
    if (msg.includes('[METAR]')) {
        debugLogs.push({
            timestamp: new Date().toLocaleTimeString(),
            message: msg,
            type: 'warn'
        });
        if (debugLogs.length > MAX_LOGS) debugLogs.shift();
    }
    originalWarn.apply(console, args);
};

console.error = (...args: any[]) => {
    const msg = args.join(' ');
    if (msg.includes('[METAR]')) {
        debugLogs.push({
            timestamp: new Date().toLocaleTimeString(),
            message: msg,
            type: 'error'
        });
        if (debugLogs.length > MAX_LOGS) debugLogs.shift();
    }
    originalError.apply(console, args);
};

export const DebugPanel: React.FC = () => {
    const [isOpen, setIsOpen] = useState(false);
    const [logs, setLogs] = useState<DebugLog[]>([]);

    useEffect(() => {
        if (isOpen) {
            const interval = setInterval(() => {
                setLogs([...debugLogs]);
            }, 500);
            return () => clearInterval(interval);
        }
    }, [isOpen]);

    if (!isOpen) {
        return (
            <button
                onClick={() => setIsOpen(true)}
                className="fixed bottom-4 right-4 z-[9999] bg-blue-600 text-white px-4 py-2 rounded-full shadow-lg font-bold text-sm"
            >
                🐛 Debug
            </button>
        );
    }

    return (
        <div className="fixed inset-0 z-[9999] pointer-events-none">
            <div className="absolute bottom-4 right-4 w-96 max-h-96 bg-black/95 text-white rounded-lg shadow-2xl pointer-events-auto overflow-hidden flex flex-col">
                <div className="flex items-center justify-between px-4 py-2 bg-blue-600">
                    <h3 className="font-bold text-sm">🐛 METAR Debug Log</h3>
                    <button
                        onClick={() => setLogs([])}
                        className="px-2 py-1 bg-blue-700 rounded text-xs mr-2"
                    >
                        Clear
                    </button>
                    <button
                        onClick={() => setIsOpen(false)}
                        className="text-xl leading-none"
                    >
                        ×
                    </button>
                </div>
                <div className="flex-1 overflow-y-auto p-2 space-y-1 text-xs font-mono">
                    {logs.length === 0 ? (
                        <div className="text-gray-400 text-center py-8">
                            No METAR logs yet.<br />
                            Refresh a location to see logs.
                        </div>
                    ) : (
                        logs.map((log, i) => (
                            <div
                                key={i}
                                className={`px-2 py-1 rounded ${log.type === 'error' ? 'bg-red-900/50 text-red-200' :
                                        log.type === 'warn' ? 'bg-yellow-900/50 text-yellow-200' :
                                            'bg-gray-800/50 text-green-200'
                                    }`}
                            >
                                <span className="text-gray-500 mr-2">{log.timestamp}</span>
                                {log.message}
                            </div>
                        ))
                    )}
                </div>
            </div>
        </div>
    );
};
