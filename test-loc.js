const { determineLocationType } = require('./services/weather/locationType.js');

// Mock data based on Mooloolaba
const Mooloolaba = { lat: -26.6848, lon: 153.1213 };
const nominatimCtx = { lat: -26.6800721, lon: 153.118742, name: "Mooloolaba, Queensland, AU" };

function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

const distToLand = calculateDistance(Mooloolaba.lat, Mooloolaba.lon, nominatimCtx.lat, nominatimCtx.lon);
console.log("distToLand:", distToLand);

// In openmeteo.ts, distToWaterIdx is 0 if Marine Proximity grid search succeeds
const distToWaterIdx = 0; // Assuming Mooloolaba found marine data

const locType = determineLocationType(
    distToLand,
    distToWaterIdx,
    nominatimCtx.name,
    true, // hasTides
    10 // elevation
);

console.log("locType:", locType);

