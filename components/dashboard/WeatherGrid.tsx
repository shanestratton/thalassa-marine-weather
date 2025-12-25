
import React from 'react';
import { Card } from './shared/Card';
import { GaugeIcon, DropletIcon, ThermometerIcon, CloudIcon, EyeIcon, ArrowUpIcon, ArrowDownIcon, WindIcon, RainIcon, WaveIcon, GearIcon, SunIcon, GripIcon, StarIcon, TideCurveIcon } from '../Icons';
import { WeatherMetrics, UnitPreferences, HourlyForecast } from '../../types';
import { convertTemp, convertDistance, getBeaufort, convertPrecip, calculateDailyScore, getSailingConditionText, convertLength } from '../../utils';
import { useThalassa } from '../../context/ThalassaContext';
import { DndContext, closestCenter, useSensor, useSensors, PointerSensor, TouchSensor } from '@dnd-kit/core';
import { arrayMove, SortableContext, rectSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

const getBeaufortConfig = (force: number) => {
    const configs = [
        { range: "< 1", desc: "Calm", sea: "Mirror-like", color: "from-blue-400 to-cyan-300", bg: "bg-gradient-to-r from-blue-900/40 to-slate-900/40", border: "border-blue-500/30", text: "text-blue-200" },
        { range: "1-3", desc: "Light Air", sea: "Ripples", color: "from-cyan-400 to-sky-300", bg: "bg-gradient-to-r from-cyan-900/40 to-slate-900/40", border: "border-cyan-500/30", text: "text-cyan-200" },
        { range: "4-6", desc: "Light Breeze", sea: "Small wavelets", color: "from-sky-400 to-teal-300", bg: "bg-gradient-to-r from-sky-900/40 to-slate-900/40", border: "border-sky-500/30", text: "text-sky-200" },
        { range: "7-10", desc: "Gentle Breeze", sea: "Large wavelets", color: "from-teal-400 to-emerald-300", bg: "bg-gradient-to-r from-teal-900/40 to-slate-900/40", border: "border-teal-500/30", text: "text-teal-200" },
        { range: "11-16", desc: "Moderate Breeze", sea: "Small waves", color: "from-emerald-400 to-green-300", bg: "bg-gradient-to-r from-emerald-900/40 to-slate-900/40", border: "border-emerald-500/30", text: "text-emerald-200" },
        { range: "17-21", desc: "Fresh Breeze", sea: "Moderate waves", color: "from-green-400 to-yellow-300", bg: "bg-gradient-to-r from-green-900/40 to-slate-900/40", border: "border-yellow-500/30", text: "text-green-200" },
        { range: "22-27", desc: "Strong Breeze", sea: "Large waves", color: "from-yellow-400 to-orange-400", bg: "bg-gradient-to-r from-yellow-900/40 to-slate-900/40", border: "border-orange-500/30", text: "text-yellow-200" },
        { range: "28-33", desc: "Near Gale", sea: "Sea heaps up", color: "from-orange-400 to-red-400", bg: "bg-gradient-to-r from-orange-900/40 to-slate-900/40", border: "border-red-500/30", text: "text-orange-200" },
        { range: "34-40", desc: "Gale", sea: "High waves", color: "from-red-400 to-rose-400", bg: "bg-gradient-to-r from-red-900/40 to-slate-900/40", border: "border-red-500/40", text: "text-red-200" },
        { range: "41-47", desc: "Strong Gale", sea: "High waves", color: "from-rose-400 to-pink-500", bg: "bg-gradient-to-r from-rose-900/40 to-slate-900/40", border: "border-rose-500/40", text: "text-rose-200" },
        { range: "48-55", desc: "Storm", sea: "Very high", color: "from-pink-500 to-purple-500", bg: "bg-gradient-to-r from-pink-900/40 to-slate-900/40", border: "border-pink-500/40", text: "text-pink-200" },
        { range: "56-63", desc: "Violent Storm", sea: "Exceptionally high", color: "from-purple-500 to-indigo-500", bg: "bg-gradient-to-r from-purple-900/40 to-slate-900/40", border: "border-purple-500/50", text: "text-purple-200" },
        { range: "64+", desc: "Hurricane", sea: "Total foam", color: "from-indigo-500 to-slate-400", bg: "bg-gradient-to-r from-indigo-900/40 to-slate-900/40", border: "border-slate-400/50", text: "text-indigo-200" }
    ];
    return configs[Math.min(force, 12)];
};

const SeaStateVisual = ({ force }: { force: number }) => {
    const width = 200;
    const height = 60;
    const points: string[] = [];
    const amplitude = force === 0 ? 0 : Math.min(20, force * 2.5); 
    const frequency = force === 0 ? 1 : 0.15 + (force * 0.03);
    for (let x = 0; x <= width; x+=2) {
        let y = 0;
        if (force > 0) {
            y += Math.sin(x * frequency) * amplitude;
            if (force > 4) y += Math.sin(x * frequency * 2.5) * (amplitude * 0.3);
            if (force > 7) y += Math.sin(x * frequency * 5.5) * (amplitude * 0.15);
        }
        const py = (height * 0.6) - y;
        points.push(`${x},${py}`);
    }
    if (points.length === 0) return null;
    const startY = points[0].split(',')[1];
    const endY = points[points.length-1].split(',')[1];
    const pathD = `M0,${height} L0,${startY} L${points.join(' L')} L${width},${endY} L${width},${height} Z`;
    return (
        <div className="w-full h-full flex items-end overflow-hidden opacity-40">
            <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-full" preserveAspectRatio="none">
                <defs>
                    <linearGradient id={`seaGrad-${force}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="currentColor" stopOpacity="0.8" />
                        <stop offset="100%" stopColor="currentColor" stopOpacity="0.1" />
                    </linearGradient>
                </defs>
                <path d={pathD} fill={`url(#seaGrad-${force})`} className="text-white" />
                {force > 3 && <path d={`M${points.join(' L')}`} fill="none" stroke="white" strokeWidth="1" strokeOpacity={force > 6 ? "0.6" : "0.3"} strokeLinecap="round" />}
            </svg>
        </div>
    );
};

interface DetailTileProps {
    label: string;
    value: string | number;
    unit?: string;
    icon: React.ReactNode;
    colorClass: string;
    subContent?: React.ReactNode;
}

const DetailTile: React.FC<DetailTileProps> = ({ label, value, unit, icon, colorClass, subContent }) => (
    <div className="bg-slate-900/40 hover:bg-slate-800/60 border border-white/5 rounded-2xl p-3 flex flex-col justify-between transition-all group relative overflow-hidden h-24">
        <div className="absolute inset-0 bg-gradient-to-br from-white/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"></div>
        <div className="flex justify-between items-start z-10">
            <div className={`p-1.5 rounded-lg bg-black/20 ${colorClass}`}>
                {icon}
            </div>
            <span className="text-[9px] font-bold uppercase tracking-widest text-gray-500 mr-4">{label}</span>
        </div>
        <div className="z-10 mt-1">
            <div className="flex items-baseline gap-1">
                <span className="text-lg font-bold text-white tracking-tight">{value}</span>
                {unit && <span className="text-[10px] font-medium text-gray-400">{unit}</span>}
            </div>
            {subContent}
        </div>
    </div>
);

const SortableMetricTile: React.FC<{ id: string; children: React.ReactNode }> = ({ id, children }) => {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
    
    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 50 : 1,
        opacity: isDragging ? 0.6 : 1,
        position: 'relative' as const,
    };

    return (
        <div ref={setNodeRef} style={style} className="h-full relative group/tile">
            {children}
            <div 
                {...attributes} 
                {...listeners} 
                className="absolute top-1.5 right-1.5 p-1.5 text-white/20 hover:text-white/80 bg-black/10 hover:bg-sky-500/80 rounded-lg transition-all cursor-grab active:cursor-grabbing backdrop-blur-sm z-30 opacity-40 group-hover/tile:opacity-100 md:opacity-0 md:group-hover/tile:opacity-100"
                title="Drag to reorder"
            >
                <GripIcon className="w-3 h-3" />
            </div>
        </div>
    );
};

export { AlertsBanner, MetricsWidget } from './WeatherGrid_exports'; 

export const BeaufortWidget = ({ windSpeed }: { windSpeed: number | null }) => {
    const beaufort = getBeaufort(windSpeed);
    const config = getBeaufortConfig(beaufort.force);
    
    return (
        <Card className="bg-slate-900/60 border border-white/10 p-4">
            <div className={`relative overflow-hidden rounded-2xl border ${config.border} ${config.bg} transition-all duration-500 group shadow-lg min-h-[90px] flex items-center`}>
                <div className="pl-6 pr-6 py-3 border-r border-white/10 flex items-center gap-4 relative z-20 bg-slate-900/20 backdrop-blur-sm h-full">
                    <div className="relative w-14 h-14 flex items-center justify-center">
                        <svg className="absolute inset-0 w-full h-full -rotate-90" viewBox="0 0 36 36">
                            <path className="text-black/30" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="currentColor" strokeWidth="4" />
                            <path className={`${config.text} drop-shadow-[0_0_8px_rgba(255,255,255,0.3)]`} strokeDasharray={`${(beaufort.force / 12) * 100}, 100`} d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
                        </svg>
                        <span className="text-xl font-black text-white">{beaufort.force}</span>
                    </div>
                    <div className="flex flex-col">
                        <span className="text-[10px] text-gray-400 uppercase font-bold tracking-wider">Beaufort Scale</span>
                        <span className={`text-lg font-bold ${config.text} leading-none`}>{config.desc}</span>
                    </div>
                </div>
                <div className="px-6 py-3 flex flex-col justify-center relative z-20">
                    <div className="flex items-center gap-2">
                        <span className="text-sm text-white font-mono bg-black/30 px-3 py-1 rounded border border-white/5">{config.range} kts</span>
                    </div>
                    <span className="text-xs text-gray-300 italic opacity-80 mt-1 truncate max-w-[200px]">
                        &quot;{config.sea}&quot;
                    </span>
                </div>
                <div className="absolute right-0 top-0 bottom-0 w-1/2 z-10 pointer-events-none">
                    <SeaStateVisual force={beaufort.force} />
                </div>
            </div>
        </Card>
    );
};

export const DetailedMetricsWidget = ({ current, units, hourly }: { current: WeatherMetrics, units: UnitPreferences, hourly?: HourlyForecast[] }) => {
    const { settings, updateSettings } = useThalassa();
    const activeWidgets = settings.detailsWidgets || ['pressure', 'humidity', 'precip', 'dewPoint', 'cloud', 'visibility', 'chill', 'swell'];

    // DnD Sensors
    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
        useSensor(TouchSensor, { activationConstraint: { delay: 100, tolerance: 5 } })
    );

    const handleDragEnd = (event: any) => {
        const { active, over } = event;
        if (active && over && active.id !== over.id) {
            const oldIndex = activeWidgets.indexOf(active.id);
            const newIndex = activeWidgets.indexOf(over.id);
            const newOrder = arrayMove(activeWidgets, oldIndex, newIndex);
            updateSettings({ detailsWidgets: newOrder });
        }
    };

    // Metric Calculations
    const rawVis = convertDistance(current.visibility, units.visibility || 'mi');
    const vis = rawVis !== '--' ? Math.round(parseFloat(rawVis)).toString() : '--';
    const precipValue = convertPrecip(current.precipitation, units.temp);
    
    // Condition Score Logic
    const score = calculateDailyScore(current.windSpeed || 0, current.waveHeight || 0, settings.vessel);
    const scoreLabel = settings.vessel?.type === 'sail' ? 'Sailing Score' : 'Cruising Score';
    const scoreText = getSailingConditionText(score);
    let scoreColor = "text-emerald-400";
    if (score < 80) scoreColor = "text-blue-400";
    if (score < 60) scoreColor = "text-yellow-400";
    if (score < 40) scoreColor = "text-red-400";

    // Tide Logic
    let tideNode = null;
    if (hourly && hourly.length > 1 && hourly[0].tideHeight !== undefined && hourly[1].tideHeight !== undefined) {
        const currTide = hourly[0].tideHeight || 0;
        const nextTide = hourly[1].tideHeight || 0;
        const diff = nextTide - currTide;
        const isRising = diff > 0;
        const rate = Math.abs(diff);
        const unit = units.tideHeight || 'm';
        
        tideNode = (
            <DetailTile 
                label="Tide Trend"
                value={convertLength(currTide, unit) ?? 0}
                unit={unit}
                colorClass={isRising ? "text-emerald-400" : "text-orange-400"}
                icon={<TideCurveIcon className="w-4 h-4" />}
                subContent={
                    <div className="flex items-center gap-1 mt-0.5 text-[9px] font-medium text-gray-400">
                        {isRising ? <ArrowUpIcon className="w-3 h-3 text-emerald-400"/> : <ArrowDownIcon className="w-3 h-3 text-orange-400"/>}
                        <span>{isRising ? "Rising" : "Falling"}</span>
                        <span className="opacity-60 ml-1">{convertLength(rate, unit)}/hr</span>
                    </div>
                }
            />
        );
    } else {
        tideNode = (
             <DetailTile 
                label="Tide Trend"
                value="--"
                unit=""
                colorClass="text-gray-500"
                icon={<TideCurveIcon className="w-4 h-4" />}
                subContent={<span className="text-[9px] text-gray-500">No Data</span>}
            />
        );
    }

    // Components Mapping
    const WIDGET_MAP: Record<string, React.ReactNode> = {
        score: (
            <DetailTile 
                label={scoreLabel}
                value={score} 
                unit="/ 100" 
                colorClass={scoreColor}
                icon={<StarIcon className="w-4 h-4" filled={score > 80} />} 
                subContent={<span className="text-[9px] text-gray-500 font-bold uppercase tracking-wider">{scoreText} Conditions</span>} 
            />
        ),
        tide: tideNode,
        pressure: (
            <DetailTile 
                label="Barometer" 
                value={current.pressure ?? '--'} 
                unit="mb" 
                colorClass="text-sky-300" 
                icon={<GaugeIcon className="w-4 h-4" />} 
                subContent={<div className="flex items-center gap-1 mt-0.5 text-[9px] font-medium text-gray-400">{current.pressureTrend === 'rising' ? <><ArrowUpIcon className="w-3 h-3 text-emerald-400" /> Rising</> : current.pressureTrend === 'falling' ? <><ArrowDownIcon className="w-3 h-3 text-red-400" /> Falling</> : "Steady"}</div>} 
            />
        ),
        humidity: (
            <DetailTile 
                label="Humidity" 
                value={`${current.humidity !== null && current.humidity !== undefined ? Math.round(current.humidity) : '--'}`} 
                unit="%" 
                colorClass="text-blue-400" 
                icon={<DropletIcon className="w-4 h-4" />} 
                subContent={<div className="h-1 w-full bg-white/10 rounded-full mt-2 overflow-hidden"><div className="h-full bg-blue-500" style={{ width: `${current.humidity || 0}%` }}></div></div>} 
            />
        ),
        precip: (
            <DetailTile 
                label="Precipitation" 
                value={precipValue || '0'} 
                unit={precipValue ? '' : units.length === 'ft' ? 'in' : 'mm'} 
                colorClass="text-cyan-300" 
                icon={<RainIcon className="w-4 h-4" />} 
                subContent={<span className="text-[9px] text-gray-500">{precipValue ? 'Accumulating' : 'Dry Conditions'}</span>} 
            />
        ),
        dewPoint: (
            <DetailTile 
                label="Dew Point" 
                value={`${convertTemp(current.dewPoint, units.temp)}°`} 
                unit="" 
                colorClass="text-rose-300" 
                icon={<ThermometerIcon className="w-4 h-4" />} 
                subContent={<span className="text-[9px] text-gray-500">Saturation Temp</span>} 
            />
        ),
        cloud: (
            <DetailTile 
                label="Cloud Cover" 
                value={`${current.cloudCover !== null && current.cloudCover !== undefined ? Math.round(current.cloudCover) : '--'}`} 
                unit="%" 
                colorClass="text-gray-300" 
                icon={<CloudIcon className="w-4 h-4" />} 
                subContent={<div className="h-1 w-full bg-white/10 rounded-full mt-2 overflow-hidden"><div className="h-full bg-gray-400" style={{ width: `${current.cloudCover || 0}%` }}></div></div>} 
            />
        ),
        visibility: (
            <DetailTile 
                label="Visibility" 
                value={vis} 
                unit={units.visibility || 'mi'} 
                colorClass="text-purple-300" 
                icon={<EyeIcon className="w-4 h-4" />} 
                subContent={<span className="text-[9px] text-gray-500">{vis !== '--' && parseFloat(vis) < 3 ? 'Restricted' : 'Clear'}</span>} 
            />
        ),
        chill: (
            <DetailTile 
                label="Wind Chill" 
                value={`${convertTemp(current.feelsLike, units.temp)}°`} 
                unit="" 
                colorClass="text-teal-300" 
                icon={<ThermometerIcon className="w-4 h-4" />} 
                subContent={<span className="text-[9px] text-gray-500">Feels Like</span>} 
            />
        ),
        swell: (
            <DetailTile 
                label="Swell Period" 
                value={`${current.swellPeriod || '--'}`} 
                unit="s" 
                colorClass="text-indigo-300" 
                icon={<WaveIcon className="w-4 h-4" />} 
                subContent={<span className="text-[9px] text-gray-500 truncate max-w-full">{current.swellDirection ? `From ${current.swellDirection}` : 'Peak Energy'}</span>} 
            />
        ),
        uv: (
            <DetailTile 
                label="UV Index" 
                value={`${current.uvIndex !== undefined ? Math.round(current.uvIndex) : '--'}`} 
                unit="" 
                colorClass="text-orange-400" 
                icon={<SunIcon className="w-4 h-4" />} 
                subContent={<span className="text-[9px] text-gray-500">Radiation Lvl</span>} 
            />
        ),
        waterTemp: (
            <DetailTile 
                label="Water Temp" 
                value={`${convertTemp(current.waterTemperature, units.temp)}°`} 
                unit="" 
                colorClass="text-blue-300" 
                icon={<ThermometerIcon className="w-4 h-4" />} 
                subContent={<span className="text-[9px] text-gray-500">Surface</span>} 
            />
        )
    };
    
    return (
        <Card className="bg-slate-900/60 border border-white/10 p-4 pt-8">
            <div className="absolute top-3 left-4 text-[10px] font-bold text-gray-500 uppercase tracking-widest flex items-center gap-2">
                <GearIcon className="w-3 h-3" /> Atmospherics
            </div>
            
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                <SortableContext items={activeWidgets} strategy={rectSortingStrategy}>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        {activeWidgets.map(id => (
                            <SortableMetricTile key={id} id={id}>
                                {WIDGET_MAP[id] || null}
                            </SortableMetricTile>
                        ))}
                    </div>
                </SortableContext>
            </DndContext>
        </Card>
    );
};
