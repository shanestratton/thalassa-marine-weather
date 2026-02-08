/**
 * Risk Dashboard
 * Comprehensive risk assessment for voyage planning
 * Shows sea state predictions, storm corridors, and vessel capability matching
 */

import React from 'react';
import { t } from '../../theme';
import { VoyagePlan, VesselProfile, HourlyForecast, Waypoint } from '../../types';
import { AlertTriangleIcon, WaveIcon, WindIcon, EyeIcon, CloudIcon } from '../Icons';

interface RiskDashboardProps {
    voyagePlan: VoyagePlan;
    vessel: VesselProfile;
    hourlyForecasts?: HourlyForecast[];
}

interface RiskFactor {
    id: string;
    name: string;
    severity: 'low' | 'moderate' | 'high' | 'critical';
    value: string;
    limit: string;
    description: string;
    icon: React.ReactNode;
}

/**
 * Calculate risk factors based on voyage plan and vessel capabilities
 */
function calculateRiskFactors(
    voyagePlan: VoyagePlan,
    vessel: VesselProfile,
    forecasts: HourlyForecast[]
): RiskFactor[] {
    const risks: RiskFactor[] = [];

    // Get max conditions from waypoints
    const maxWindWP = Math.max(...(voyagePlan.waypoints || []).map(wp => wp.windSpeed || 0), 0);
    const maxWaveWP = Math.max(...(voyagePlan.waypoints || []).map(wp => wp.waveHeight || 0), 0);

    // Get max from forecasts if available
    const maxWindForecast = Math.max(...forecasts.map(h => h.windSpeed || 0), 0);
    const maxWaveForecast = Math.max(...forecasts.map(h => h.waveHeight || 0), 0);
    const minVisibility = Math.min(...forecasts.filter(h => h.visibility != null).map(h => h.visibility as number), 10);

    // Use whichever is higher
    const maxWind = Math.max(maxWindWP, maxWindForecast, voyagePlan.suitability?.maxWindEncountered || 0);
    const maxWave = Math.max(maxWaveWP, maxWaveForecast, voyagePlan.suitability?.maxWaveEncountered || 0);

    // Wind Risk
    const windLimit = vessel.maxWindSpeed || 25;
    const windRatio = maxWind / windLimit;
    let windSeverity: RiskFactor['severity'] = 'low';
    let windDesc = 'Winds within comfortable limits';
    if (windRatio > 1) {
        windSeverity = 'critical';
        windDesc = 'Winds exceed vessel capability - postpone voyage';
    } else if (windRatio > 0.8) {
        windSeverity = 'high';
        windDesc = 'Near vessel wind limit - experienced crew only';
    } else if (windRatio > 0.6) {
        windSeverity = 'moderate';
        windDesc = 'Moderate winds expected - stay alert';
    }
    risks.push({
        id: 'wind',
        name: 'Wind Stress',
        severity: windSeverity,
        value: `${maxWind.toFixed(0)} kts`,
        limit: `${windLimit} kts`,
        description: windDesc,
        icon: <WindIcon className="w-4 h-4" />
    });

    // Sea State Risk
    const waveLimit = vessel.maxWaveHeight || 3;
    const waveRatio = maxWave / waveLimit;
    let waveSeverity: RiskFactor['severity'] = 'low';
    let waveDesc = 'Sea state within comfortable limits';
    if (waveRatio > 1) {
        waveSeverity = 'critical';
        waveDesc = 'Seas exceed vessel capability - postpone voyage';
    } else if (waveRatio > 0.8) {
        waveSeverity = 'high';
        waveDesc = 'Heavy seas expected - prepare crew';
    } else if (waveRatio > 0.6) {
        waveSeverity = 'moderate';
        waveDesc = 'Moderate seas - ensure all gear secured';
    }
    risks.push({
        id: 'seas',
        name: 'Sea State',
        severity: waveSeverity,
        value: `${maxWave.toFixed(1)} m`,
        limit: `${waveLimit} m`,
        description: waveDesc,
        icon: <WaveIcon className="w-4 h-4" />
    });

    // Visibility Risk
    let visSeverity: RiskFactor['severity'] = 'low';
    let visDesc = 'Good visibility expected';
    if (minVisibility < 1) {
        visSeverity = 'critical';
        visDesc = 'Poor visibility - consider postponing';
    } else if (minVisibility < 3) {
        visSeverity = 'high';
        visDesc = 'Reduced visibility - radar essential';
    } else if (minVisibility < 5) {
        visSeverity = 'moderate';
        visDesc = 'Limited visibility periods expected';
    }
    risks.push({
        id: 'visibility',
        name: 'Visibility',
        severity: visSeverity,
        value: `${minVisibility.toFixed(0)} km`,
        limit: '5 km',
        description: visDesc,
        icon: <EyeIcon className="w-4 h-4" />
    });

    // Night Passage Risk (based on duration)
    const durationMatch = voyagePlan.durationApprox?.match(/(\d+)/);
    const durationHours = durationMatch ? parseInt(durationMatch[1], 10) : 0;
    let nightSeverity: RiskFactor['severity'] = 'low';
    let nightDesc = 'Daylight passage expected';
    if (durationHours > 24) {
        nightSeverity = 'high';
        nightDesc = 'Multi-day passage - watch schedule required';
    } else if (durationHours > 12) {
        nightSeverity = 'moderate';
        nightDesc = 'Night crossing likely - ensure nav lights';
    } else if (durationHours > 8) {
        nightSeverity = 'low';
        nightDesc = 'Possible dusk/dawn transit';
    }
    risks.push({
        id: 'night',
        name: 'Night Passage',
        severity: nightSeverity,
        value: `${durationHours}h`,
        limit: '12h',
        description: nightDesc,
        icon: <CloudIcon className="w-4 h-4" />
    });

    return risks;
}

const severityColors = {
    low: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400',
    moderate: 'bg-amber-500/10 border-amber-500/30 text-amber-400',
    high: 'bg-orange-500/10 border-orange-500/30 text-orange-400',
    critical: 'bg-red-500/10 border-red-500/30 text-red-400'
};

const severityBadgeColors = {
    low: 'bg-emerald-500/20 text-emerald-300',
    moderate: 'bg-amber-500/20 text-amber-300',
    high: 'bg-orange-500/20 text-orange-300',
    critical: 'bg-red-500/20 text-red-300'
};

export const RiskDashboard: React.FC<RiskDashboardProps> = ({
    voyagePlan,
    vessel,
    hourlyForecasts = []
}) => {
    const risks = calculateRiskFactors(voyagePlan, vessel, hourlyForecasts);

    // Calculate overall risk level
    const hasCritical = risks.some(r => r.severity === 'critical');
    const hasHigh = risks.some(r => r.severity === 'high');
    const hasModerate = risks.some(r => r.severity === 'moderate');

    const overallLevel = hasCritical ? 'CRITICAL' : hasHigh ? 'HIGH' : hasModerate ? 'MODERATE' : 'LOW';
    const overallColor = hasCritical ? 'text-red-400' : hasHigh ? 'text-orange-400' : hasModerate ? 'text-amber-400' : 'text-emerald-400';
    const overallBg = hasCritical ? 'bg-red-500/10 border-red-500/30' : hasHigh ? 'bg-orange-500/10 border-orange-500/30' : hasModerate ? 'bg-amber-500/10 border-amber-500/30' : 'bg-emerald-500/10 border-emerald-500/30';

    return (
        <div className="space-y-4">
            {/* Header with Overall Risk */}
            <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
                    <AlertTriangleIcon className="w-4 h-4 text-orange-400" />
                    Risk Assessment
                </h3>
                <div className={`px-3 py-1 rounded-lg border ${overallBg}`}>
                    <span className={`text-sm font-black uppercase tracking-wider ${overallColor}`}>
                        {overallLevel} RISK
                    </span>
                </div>
            </div>

            {/* Risk Cards Grid */}
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {risks.map((risk) => (
                    <div
                        key={risk.id}
                        className={`rounded-xl p-3 border transition-all ${severityColors[risk.severity]}`}
                    >
                        <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                                <span className="opacity-70">{risk.icon}</span>
                                <span className="text-sm font-bold uppercase tracking-wider text-white/80">
                                    {risk.name}
                                </span>
                            </div>
                            <span className={`text-sm font-bold uppercase px-1.5 py-0.5 rounded ${severityBadgeColors[risk.severity]}`}>
                                {risk.severity}
                            </span>
                        </div>

                        <div className="flex items-baseline gap-2 mb-1">
                            <span className="text-lg font-bold text-white">{risk.value}</span>
                            <span className="text-sm text-slate-500">/ {risk.limit} max</span>
                        </div>

                        <p className="text-sm text-slate-400 leading-tight">{risk.description}</p>
                    </div>
                ))}
            </div>

            {/* Vessel Capability Summary */}
            <div className={`bg-slate-800/50 rounded-xl p-3 ${t.border.default}`}>
                <div className="text-sm text-slate-500 uppercase tracking-wider mb-2 font-bold">
                    Vessel Capability Match
                </div>
                <div className="flex flex-wrap gap-3 text-sm text-white">
                    <span className="bg-white/5 px-2 py-1 rounded">
                        <span className="text-slate-400">Type:</span> {vessel.type}
                    </span>
                    <span className="bg-white/5 px-2 py-1 rounded">
                        <span className="text-slate-400">Length:</span> {vessel.length}m
                    </span>
                    <span className="bg-white/5 px-2 py-1 rounded">
                        <span className="text-slate-400">Max Wind:</span> {vessel.maxWindSpeed}kts
                    </span>
                    <span className="bg-white/5 px-2 py-1 rounded">
                        <span className="text-slate-400">Max Seas:</span> {vessel.maxWaveHeight}m
                    </span>
                </div>
            </div>
        </div>
    );
};
