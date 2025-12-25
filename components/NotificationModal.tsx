import React from 'react';
import { NotificationPreferences } from '../types';
import { XIcon, WindIcon, WaveIcon, RainIcon } from './Icons';

interface NotificationModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: NotificationPreferences;
  onSave: (settings: NotificationPreferences) => void;
}

export const NotificationModal: React.FC<NotificationModalProps> = ({ 
  isOpen, 
  onClose, 
  settings, 
  onSave 
}) => {
  const [localSettings, setLocalSettings] = React.useState<NotificationPreferences>(settings);

  // Sync when opening
  React.useEffect(() => {
    setLocalSettings(settings);
  }, [settings, isOpen]);

  if (!isOpen) return null;

  const updateSetting = (key: keyof NotificationPreferences, field: 'enabled' | 'threshold', value: any) => {
    setLocalSettings(prev => ({
      ...prev,
      [key]: {
        ...prev[key],
        [field]: value
      }
    }));
  };

  const handleSave = () => {
    onSave(localSettings);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity" 
        onClick={onClose}
      />

      {/* Modal Content */}
      <div className="relative bg-slate-900/90 border border-white/10 rounded-3xl w-full max-w-md shadow-2xl p-6 overflow-hidden transform transition-all scale-100">
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-xl font-semibold text-white">Weather Alerts</h3>
          <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-full transition-colors">
            <XIcon className="w-5 h-5 text-gray-400" />
          </button>
        </div>

        <div className="space-y-6">
          
          {/* Wind Setting */}
          <div className="bg-white/5 rounded-2xl p-4 border border-white/5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center space-x-3">
                <div className="bg-purple-500/20 p-2 rounded-lg text-purple-300">
                  <WindIcon className="w-5 h-5" />
                </div>
                <div>
                  <p className="font-medium text-white">High Wind</p>
                  <p className="text-xs text-gray-400">Alert when wind exceeds</p>
                </div>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input 
                  type="checkbox" 
                  className="sr-only peer"
                  checked={localSettings.wind.enabled}
                  onChange={(e) => updateSetting('wind', 'enabled', e.target.checked)}
                />
                <div className="w-11 h-6 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-purple-600"></div>
              </label>
            </div>
            
            {localSettings.wind.enabled && (
               <div className="flex items-center space-x-2 mt-2 pl-12 animate-in fade-in slide-in-from-top-2 duration-300">
                  <input 
                    type="number" 
                    value={localSettings.wind.threshold}
                    onChange={(e) => updateSetting('wind', 'threshold', Number(e.target.value))}
                    className="w-20 bg-black/30 border border-white/10 rounded-lg px-3 py-1.5 text-white text-sm focus:border-purple-500 outline-none"
                  />
                  <span className="text-sm text-gray-400">knots</span>
               </div>
            )}
          </div>

          {/* Wave Setting */}
          <div className="bg-white/5 rounded-2xl p-4 border border-white/5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center space-x-3">
                <div className="bg-sky-500/20 p-2 rounded-lg text-sky-300">
                  <WaveIcon className="w-5 h-5" />
                </div>
                <div>
                  <p className="font-medium text-white">High Surf</p>
                  <p className="text-xs text-gray-400">Alert when waves exceed</p>
                </div>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input 
                  type="checkbox" 
                  className="sr-only peer"
                  checked={localSettings.waves.enabled}
                  onChange={(e) => updateSetting('waves', 'enabled', e.target.checked)}
                />
                <div className="w-11 h-6 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-sky-500"></div>
              </label>
            </div>
            
            {localSettings.waves.enabled && (
               <div className="flex items-center space-x-2 mt-2 pl-12 animate-in fade-in slide-in-from-top-2 duration-300">
                  <input 
                    type="number" 
                    value={localSettings.waves.threshold}
                    onChange={(e) => updateSetting('waves', 'threshold', Number(e.target.value))}
                    className="w-20 bg-black/30 border border-white/10 rounded-lg px-3 py-1.5 text-white text-sm focus:border-sky-500 outline-none"
                  />
                  <span className="text-sm text-gray-400">feet</span>
               </div>
            )}
          </div>

          {/* Precipitation Setting */}
          <div className="bg-white/5 rounded-2xl p-4 border border-white/5">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-3">
                <div className="bg-blue-500/20 p-2 rounded-lg text-blue-300">
                  <RainIcon className="w-5 h-5" />
                </div>
                <div>
                  <p className="font-medium text-white">Precipitation</p>
                  <p className="text-xs text-gray-400">Alert when raining or stormy</p>
                </div>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input 
                  type="checkbox" 
                  className="sr-only peer"
                  checked={localSettings.precipitation.enabled}
                  onChange={(e) => updateSetting('precipitation', 'enabled', e.target.checked)}
                />
                <div className="w-11 h-6 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
              </label>
            </div>
          </div>

        </div>

        <button 
          onClick={handleSave}
          className="w-full mt-8 bg-sky-500 hover:bg-sky-400 text-white font-medium py-3 rounded-xl transition-colors shadow-lg shadow-sky-500/20"
        >
          Save Preferences
        </button>

      </div>
    </div>
  );
};
