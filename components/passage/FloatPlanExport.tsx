/**
 * Float Plan Generator
 * Creates a US Coast Guard-style float plan for safety documentation
 */

import React, { useState } from 'react';
import { t } from '../../theme';
import { VoyagePlan, VesselProfile } from '../../types';
import { ShareIcon, PhoneIcon, CheckIcon, XIcon } from '../Icons';

interface FloatPlanProps {
    voyagePlan: VoyagePlan;
    vessel: VesselProfile;
}

interface FloatPlanData {
    operatorName: string;
    operatorPhone: string;
    emergencyContact: string;
    emergencyPhone: string;
    crewCount: number;
    crewNames: string;
    expectedReturn: string;
    overduePlan: string;
    safetyEquipment: string[];
}

const DEFAULT_SAFETY_EQUIPMENT = [
    'Life Jackets (PFDs)',
    'VHF Radio',
    'EPIRB',
    'Flares',
    'Fire Extinguisher',
    'First Aid Kit',
    'Navigation Lights',
    'Anchor & Rode',
    'Sound Signal'
];

export const FloatPlanExport: React.FC<FloatPlanProps> = ({
    voyagePlan,
    vessel
}) => {
    const [showModal, setShowModal] = useState(false);
    const [formData, setFormData] = useState<FloatPlanData>({
        operatorName: '',
        operatorPhone: '',
        emergencyContact: '',
        emergencyPhone: '',
        crewCount: 2,
        crewNames: '',
        expectedReturn: '',
        overduePlan: 'Contact Coast Guard if not returned within 24 hours of expected return time.',
        safetyEquipment: [...DEFAULT_SAFETY_EQUIPMENT]
    });

    const updateField = (field: keyof FloatPlanData, value: string | number | string[]) => {
        setFormData(prev => ({ ...prev, [field]: value }));
    };

    const toggleEquipment = (item: string) => {
        setFormData(prev => ({
            ...prev,
            safetyEquipment: prev.safetyEquipment.includes(item)
                ? prev.safetyEquipment.filter(e => e !== item)
                : [...prev.safetyEquipment, item]
        }));
    };

    const generateFloatPlan = () => {
        const now = new Date();
        const html = `
<!DOCTYPE html>
<html>
<head>
    <title>Float Plan - ${voyagePlan.origin} to ${voyagePlan.destination}</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; line-height: 1.4; }
        h1 { color: #1e3a5f; border-bottom: 3px solid #1e3a5f; padding-bottom: 8px; }
        h2 { color: #333; margin-top: 20px; border-bottom: 1px solid #ccc; padding-bottom: 4px; }
        .section { margin-bottom: 20px; }
        .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        .field { margin-bottom: 12px; }
        .label { font-weight: bold; color: #555; font-size: 12px; text-transform: uppercase; }
        .value { font-size: 14px; padding: 4px 0; border-bottom: 1px dotted #ccc; }
        .warning { background: #fff3cd; border: 1px solid #ffc107; padding: 12px; border-radius: 4px; margin-top: 20px; }
        .equipment-list { columns: 2; }
        .equipment-list li { margin-bottom: 4px; }
        @media print { body { margin: 0; } }
    </style>
</head>
<body>
    <h1>⚓ FLOAT PLAN</h1>
    
    <div class="section">
        <h2>Vessel Information</h2>
        <div class="grid">
            <div class="field">
                <div class="label">Vessel Name</div>
                <div class="value">${vessel.name || 'N/A'}</div>
            </div>
            <div class="field">
                <div class="label">Vessel Type</div>
                <div class="value">${vessel.type?.toUpperCase() || 'N/A'}</div>
            </div>
            <div class="field">
                <div class="label">Length</div>
                <div class="value">${vessel.length} m</div>
            </div>
            <div class="field">
                <div class="label">Hull Color</div>
                <div class="value">${vessel.hullColor || 'N/A'}</div>
            </div>
            <div class="field">
                <div class="label">Registration</div>
                <div class="value">${vessel.registration || 'N/A'}</div>
            </div>
            <div class="field">
                <div class="label">MMSI / Call Sign</div>
                <div class="value">${vessel.mmsi || 'N/A'}</div>
            </div>
        </div>
    </div>

    <div class="section">
        <h2>Voyage Details</h2>
        <div class="grid">
            <div class="field">
                <div class="label">Departure Point</div>
                <div class="value">${voyagePlan.origin}</div>
            </div>
            <div class="field">
                <div class="label">Destination</div>
                <div class="value">${voyagePlan.destination}</div>
            </div>
            <div class="field">
                <div class="label">Departure Date</div>
                <div class="value">${voyagePlan.departureDate || now.toLocaleDateString()}</div>
            </div>
            <div class="field">
                <div class="label">Expected Return</div>
                <div class="value">${formData.expectedReturn || 'TBD'}</div>
            </div>
            <div class="field">
                <div class="label">Distance</div>
                <div class="value">${voyagePlan.distanceApprox}</div>
            </div>
            <div class="field">
                <div class="label">Estimated Duration</div>
                <div class="value">${voyagePlan.durationApprox}</div>
            </div>
        </div>
    </div>

    <div class="section">
        <h2>Operator & Crew</h2>
        <div class="grid">
            <div class="field">
                <div class="label">Operator Name</div>
                <div class="value">${formData.operatorName || 'N/A'}</div>
            </div>
            <div class="field">
                <div class="label">Operator Phone</div>
                <div class="value">${formData.operatorPhone || 'N/A'}</div>
            </div>
            <div class="field">
                <div class="label">Number of Persons Aboard</div>
                <div class="value">${formData.crewCount}</div>
            </div>
            <div class="field">
                <div class="label">Crew Names</div>
                <div class="value">${formData.crewNames || 'N/A'}</div>
            </div>
        </div>
    </div>

    <div class="section">
        <h2>Emergency Contact (Shore)</h2>
        <div class="grid">
            <div class="field">
                <div class="label">Contact Name</div>
                <div class="value">${formData.emergencyContact || 'N/A'}</div>
            </div>
            <div class="field">
                <div class="label">Contact Phone</div>
                <div class="value">${formData.emergencyPhone || 'N/A'}</div>
            </div>
        </div>
    </div>

    <div class="section">
        <h2>Safety Equipment Aboard</h2>
        <ul class="equipment-list">
            ${formData.safetyEquipment.map(item => `<li>✓ ${item}</li>`).join('')}
        </ul>
    </div>

    <div class="section">
        <h2>Route Plan</h2>
        <p><strong>Origin:</strong> ${voyagePlan.origin}</p>
        ${voyagePlan.waypoints && voyagePlan.waypoints.length > 0
                ? `<p><strong>Via:</strong> ${voyagePlan.waypoints.map(wp => wp.name).join(' → ')}</p>`
                : ''}
        <p><strong>Destination:</strong> ${voyagePlan.destination}</p>
    </div>

    <div class="warning">
        <strong>⚠️ Overdue Plan:</strong><br>
        ${formData.overduePlan}
    </div>

    <div style="margin-top: 40px; font-size: 11px; color: #666;">
        <p>Float plan generated: ${now.toLocaleString()}</p>
        <p>FILE THIS PLAN WITH A RESPONSIBLE PERSON ASHORE.</p>
        <p>REMEMBER TO NOTIFY THEM WHEN YOU RETURN SAFELY.</p>
    </div>
</body>
</html>`;

        // Open in new window for printing
        const printWindow = window.open('', '_blank');
        if (printWindow) {
            printWindow.document.write(html);
            printWindow.document.close();
            printWindow.focus();
            setTimeout(() => printWindow.print(), 250);
        }
    };

    return (
        <>
            <button
                onClick={() => setShowModal(true)}
                className="flex items-center gap-2 px-4 py-2 bg-sky-500/20 border border-sky-500/30 rounded-xl text-sky-300 text-sm font-bold hover:bg-sky-500/30 transition-colors"
            >
                <ShareIcon className="w-4 h-4" />
                Generate Float Plan
            </button>

            {/* Modal */}
            {showModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 modal-backdrop-enter bg-black/70 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Float plan export">
                    <div className={`modal-panel-enter bg-slate-900 ${t.border.strong} rounded-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto shadow-2xl`}>
                        {/* Header */}
                        <div className="flex items-center justify-between p-4 border-b border-white/10">
                            <h3 className="text-lg font-bold text-white flex items-center gap-2">
                                <ShareIcon className="w-5 h-5 text-sky-400" />
                                Float Plan Generator
                            </h3>
                            <button
                                onClick={() => setShowModal(false)}
                                className="p-2 text-slate-400 hover:text-white hover:bg-white/10 rounded-lg"
                            >
                                <XIcon className="w-5 h-5" />
                            </button>
                        </div>

                        {/* Form */}
                        <div className="p-4 space-y-4">
                            {/* Operator Info */}
                            <div className="space-y-3">
                                <h4 className="text-sm font-bold text-slate-400 uppercase tracking-wider">Operator</h4>
                                <div className="grid grid-cols-2 gap-3">
                                    <input
                                        type="text"
                                        placeholder="Operator Name"
                                        value={formData.operatorName}
                                        onChange={(e) => updateField('operatorName', e.target.value)}
                                        className={`bg-slate-800/50 ${t.border.default} rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500`}
                                    />
                                    <input
                                        type="tel"
                                        placeholder="Phone"
                                        value={formData.operatorPhone}
                                        onChange={(e) => updateField('operatorPhone', e.target.value)}
                                        className={`bg-slate-800/50 ${t.border.default} rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500`}
                                    />
                                </div>
                            </div>

                            {/* Crew Info */}
                            <div className="space-y-3">
                                <h4 className="text-sm font-bold text-slate-400 uppercase tracking-wider">Crew</h4>
                                <div className="grid grid-cols-3 gap-3">
                                    <input
                                        type="number"
                                        placeholder="# Aboard"
                                        value={formData.crewCount}
                                        onChange={(e) => updateField('crewCount', parseInt(e.target.value) || 1)}
                                        className={`bg-slate-800/50 ${t.border.default} rounded-lg px-3 py-2 text-sm text-white`}
                                    />
                                    <input
                                        type="text"
                                        placeholder="Crew Names"
                                        value={formData.crewNames}
                                        onChange={(e) => updateField('crewNames', e.target.value)}
                                        className={`col-span-2 bg-slate-800/50 ${t.border.default} rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500`}
                                    />
                                </div>
                            </div>

                            {/* Emergency Contact */}
                            <div className="space-y-3">
                                <h4 className="text-sm font-bold text-slate-400 uppercase tracking-wider">Emergency Contact (Shore)</h4>
                                <div className="grid grid-cols-2 gap-3">
                                    <input
                                        type="text"
                                        placeholder="Contact Name"
                                        value={formData.emergencyContact}
                                        onChange={(e) => updateField('emergencyContact', e.target.value)}
                                        className={`bg-slate-800/50 ${t.border.default} rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500`}
                                    />
                                    <input
                                        type="tel"
                                        placeholder="Phone"
                                        value={formData.emergencyPhone}
                                        onChange={(e) => updateField('emergencyPhone', e.target.value)}
                                        className={`bg-slate-800/50 ${t.border.default} rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500`}
                                    />
                                </div>
                            </div>

                            {/* Expected Return */}
                            <div className="space-y-3">
                                <h4 className="text-sm font-bold text-slate-400 uppercase tracking-wider">Expected Return</h4>
                                <input
                                    type="text"
                                    placeholder="e.g., Sunday 6pm or 2024-02-10"
                                    value={formData.expectedReturn}
                                    onChange={(e) => updateField('expectedReturn', e.target.value)}
                                    className={`w-full bg-slate-800/50 ${t.border.default} rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500`}
                                />
                            </div>

                            {/* Safety Equipment */}
                            <div className="space-y-3">
                                <h4 className="text-sm font-bold text-slate-400 uppercase tracking-wider">Safety Equipment</h4>
                                <div className="grid grid-cols-2 gap-2">
                                    {DEFAULT_SAFETY_EQUIPMENT.map((item) => (
                                        <button
                                            key={item}
                                            onClick={() => toggleEquipment(item)}
                                            className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-left transition-colors ${formData.safetyEquipment.includes(item)
                                                ? 'bg-emerald-500/20 border border-emerald-500/30 text-emerald-300'
                                                : `bg-slate-800/50 border border-white/10 text-slate-400`
                                                }`}
                                        >
                                            {formData.safetyEquipment.includes(item) && (
                                                <CheckIcon className="w-3 h-3" />
                                            )}
                                            {item}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        </div>

                        {/* Footer */}
                        <div className="p-4 border-t border-white/10 flex gap-3">
                            <button
                                onClick={() => setShowModal(false)}
                                className={`flex-1 px-4 py-2 bg-slate-800/50 ${t.border.default} rounded-xl text-slate-300 text-sm font-bold hover:bg-slate-700 transition-colors`}
                            >
                                Cancel
                            </button>
                            <button
                                onClick={generateFloatPlan}
                                className="flex-1 px-4 py-2 bg-sky-500 rounded-xl text-white text-sm font-bold hover:bg-sky-400 transition-colors"
                            >
                                Generate & Print
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
};
