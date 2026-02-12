/**
 * Region Autocomplete Component
 * Text input with dropdown suggestions from a curated worldwide regions list.
 * Users can still type a custom value if their region isn't listed.
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';

// Curated list of known regions to prevent inconsistency
// (QLD vs Qld vs Queensland, etc.)
export const KNOWN_REGIONS = [
    // Australia
    'QLD, Australia',
    'NSW, Australia',
    'VIC, Australia',
    'SA, Australia',
    'WA, Australia',
    'TAS, Australia',
    'NT, Australia',
    'ACT, Australia',

    // New Zealand
    'Auckland, NZ',
    'Northland, NZ',
    'Bay of Plenty, NZ',
    'Waikato, NZ',
    'Wellington, NZ',
    'Canterbury, NZ',
    'Otago, NZ',
    'Marlborough, NZ',
    'Nelson, NZ',
    'Hawke\'s Bay, NZ',
    'Taranaki, NZ',
    'Southland, NZ',

    // Pacific Islands
    'Fiji',
    'Tonga',
    'Vanuatu',
    'New Caledonia',
    'Samoa',
    'Papua New Guinea',
    'Solomon Islands',
    'Tahiti',

    // USA - Coastal States
    'Alaska, USA',
    'California, USA',
    'Florida, USA',
    'Hawaii, USA',
    'Maine, USA',
    'Maryland, USA',
    'Massachusetts, USA',
    'Michigan, USA',
    'New York, USA',
    'North Carolina, USA',
    'Oregon, USA',
    'South Carolina, USA',
    'Texas, USA',
    'Virginia, USA',
    'Washington, USA',
    'Connecticut, USA',
    'Rhode Island, USA',
    'Louisiana, USA',
    'Mississippi, USA',
    'Alabama, USA',
    'Georgia, USA',
    'New Jersey, USA',
    'Delaware, USA',
    'New Hampshire, USA',

    // Caribbean
    'Bahamas',
    'British Virgin Islands',
    'US Virgin Islands',
    'Cayman Islands',
    'Turks & Caicos',
    'Bermuda',
    'Antigua & Barbuda',
    'St. Martin',
    'Grenada',
    'Trinidad & Tobago',
    'Jamaica',
    'Puerto Rico',
    'Cuba',
    'Dominican Republic',

    // Europe
    'United Kingdom',
    'England, UK',
    'Scotland, UK',
    'Wales, UK',
    'Ireland',
    'France',
    'Spain',
    'Portugal',
    'Italy',
    'Greece',
    'Croatia',
    'Montenegro',
    'Turkey',
    'Norway',
    'Sweden',
    'Denmark',
    'Netherlands',
    'Germany',
    'Finland',
    'Estonia',
    'Latvia',
    'Poland',
    'Malta',
    'Cyprus',
    'Iceland',

    // Mediterranean
    'Mediterranean, France',
    'Mediterranean, Spain',
    'Sardinia, Italy',
    'Sicily, Italy',
    'Adriatic, Croatia',
    'Aegean, Greece',
    'Ionian, Greece',

    // Asia
    'Thailand',
    'Malaysia',
    'Indonesia',
    'Philippines',
    'Vietnam',
    'Japan',
    'South Korea',
    'Singapore',
    'Hong Kong',
    'Taiwan',
    'Sri Lanka',
    'Maldives',
    'India',

    // Middle East
    'UAE',
    'Oman',
    'Saudi Arabia',

    // Africa
    'South Africa',
    'Mozambique',
    'Madagascar',
    'Mauritius',
    'Seychelles',
    'Kenya',
    'Tanzania',
    'Egypt',
    'Morocco',
    'Canary Islands',

    // Central & South America
    'Panama',
    'Costa Rica',
    'Belize',
    'Mexico',
    'Colombia',
    'Ecuador',
    'Galapagos',
    'Brazil',
    'Argentina',
    'Chile',

    // Canada
    'British Columbia, Canada',
    'Nova Scotia, Canada',
    'Ontario, Canada',
    'Prince Edward Island, Canada',
    'Newfoundland, Canada',
    'New Brunswick, Canada',
    'Quebec, Canada',
];

interface RegionAutocompleteProps {
    defaultValue?: string;
    placeholder?: string;
    /** Called whenever the value changes */
    onChange?: (value: string) => void;
    /** CSS class for the input */
    inputClassName?: string;
    /** Unique ID for the input element */
    id?: string;
}

export const RegionAutocomplete: React.FC<RegionAutocompleteProps> = ({
    defaultValue = '',
    placeholder = 'e.g. "QLD, Australia"',
    onChange,
    inputClassName,
    id,
}) => {
    const [value, setValue] = useState(defaultValue);
    const [suggestions, setSuggestions] = useState<string[]>([]);
    const [showDropdown, setShowDropdown] = useState(false);
    const [highlightedIndex, setHighlightedIndex] = useState(-1);
    const inputRef = useRef<HTMLInputElement>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);

    // Update value when defaultValue changes (e.g. auto-detected region)
    useEffect(() => {
        if (defaultValue) setValue(defaultValue);
    }, [defaultValue]);

    const filterSuggestions = useCallback((query: string) => {
        if (!query.trim()) {
            setSuggestions([]);
            return;
        }
        const lower = query.toLowerCase();
        const matches = KNOWN_REGIONS.filter(r =>
            r.toLowerCase().includes(lower)
        ).slice(0, 8); // Max 8 suggestions
        setSuggestions(matches);
    }, []);

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const newVal = e.target.value;
        setValue(newVal);
        filterSuggestions(newVal);
        setShowDropdown(true);
        setHighlightedIndex(-1);
        onChange?.(newVal);
    };

    const selectSuggestion = (suggestion: string) => {
        setValue(suggestion);
        setSuggestions([]);
        setShowDropdown(false);
        onChange?.(suggestion);
        inputRef.current?.blur();
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (!showDropdown || suggestions.length === 0) return;

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setHighlightedIndex(prev => Math.min(prev + 1, suggestions.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHighlightedIndex(prev => Math.max(prev - 1, 0));
        } else if (e.key === 'Enter' && highlightedIndex >= 0) {
            e.preventDefault();
            selectSuggestion(suggestions[highlightedIndex]);
        } else if (e.key === 'Escape') {
            setShowDropdown(false);
        }
    };

    // Close dropdown when clicking outside
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (
                dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
                inputRef.current && !inputRef.current.contains(e.target as Node)
            ) {
                setShowDropdown(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    return (
        <div className="relative">
            <input
                ref={inputRef}
                id={id}
                type="text"
                value={value}
                onChange={handleInputChange}
                onFocus={() => { filterSuggestions(value); setShowDropdown(true); }}
                onKeyDown={handleKeyDown}
                placeholder={placeholder}
                className={inputClassName}
                autoComplete="off"
            />
            {showDropdown && suggestions.length > 0 && (
                <div
                    ref={dropdownRef}
                    className="absolute z-50 left-0 right-0 mt-1 bg-slate-800 border border-white/15 rounded-xl shadow-xl overflow-hidden max-h-48 overflow-y-auto"
                >
                    {suggestions.map((suggestion, i) => (
                        <button
                            key={suggestion}
                            type="button"
                            onClick={() => selectSuggestion(suggestion)}
                            className={`w-full text-left px-3 py-2.5 text-sm transition-colors ${i === highlightedIndex
                                    ? 'bg-violet-600/30 text-white'
                                    : 'text-slate-300 hover:bg-slate-700/50 hover:text-white'
                                }`}
                        >
                            {suggestion}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
};
