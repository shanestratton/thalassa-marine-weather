import React from 'react';
import type { EngineMetric } from '../../services/instruments/engineTelemetry';
import { type InstrumentEvidence, usableReading } from '../../services/instruments/measurements';

export function enginePanelAvailable(evidence: InstrumentEvidence | undefined, now: number): boolean {
    return usableReading(evidence?.readings.rpm, 'rpm', now, 0, 20_000);
}
export function EngineReadout({ evidence, now }: { evidence: InstrumentEvidence; now: number }) {
    const rpm = evidence.readings.rpm;
    if (!usableReading(rpm, 'rpm', now, 0, 20_000)) return null;
    const metrics = rpm.engineCount === 1 && evidence.engine?.engineId === rpm.engineId ? evidence.engine : undefined;
    const rows: [string, EngineMetric | undefined, (n: number) => string][] = [
        [
            'Engine meter',
            metrics?.runTime,
            (n) => `${(n / 3600).toLocaleString(undefined, { maximumFractionDigits: 1 })} h`,
        ],
        ['Coolant', metrics?.coolant, (n) => `${n.toFixed(1)} °C`],
        ['Oil pressure', metrics?.oilPressure, (n) => `${n.toFixed(0)} kPa`],
    ];
    return (
        <div className="flex-1 min-h-0 flex flex-col justify-evenly gap-2 py-2 text-center" data-engine-readout>
            <p className="text-sm text-gray-400 break-words">
                {rpm.engineId ? `Engine: ${rpm.engineId}` : 'Reported engine RPM'}
            </p>
            <p className={`text-5xl font-mono tabular-nums ${now - rpm.at > 6500 ? 'opacity-50' : ''}`}>
                {Math.round(rpm.value).toLocaleString()} <span className="text-base">RPM</span>
            </p>
            <dl className="grid grid-cols-1 gap-3">
                {rows.map(([label, reading, format]) => {
                    const age = reading ? now - reading.at : Infinity;
                    const available =
                        !!reading && Number.isFinite(reading.value) && reading.at > 0 && age >= -1000 && age <= 13_000;
                    return (
                        <div key={label} className={available && age > 6500 ? 'opacity-50' : ''}>
                            <dt className="text-sm text-gray-400">{label}</dt>
                            <dd className="text-xl font-mono tabular-nums">
                                {available ? format(reading.value) : '—'}
                            </dd>
                            <p className="text-sm text-gray-400">
                                {available ? `${Math.max(0, Math.floor(age / 1000))}s ago` : 'Not reporting'}
                            </p>
                        </div>
                    );
                })}
            </dl>
            <p className="text-sm text-gray-400">
                {rpm.engineCount && rpm.engineCount > 1
                    ? `${rpm.engineCount} reported engines; meters are not combined.`
                    : 'Measured aboard. Maintenance hours require your confirmation.'}
            </p>
        </div>
    );
}
