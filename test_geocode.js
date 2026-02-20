const https = require('https');
const fs = require('fs');

// Get Mapbox key from env or config file
const keyFile = '/Users/shanestratton/Projects/thalassa-marine-weather/.env.local';
let key = '';
if (fs.existsSync(keyFile)) {
    const env = fs.readFileSync(keyFile, 'utf8');
    const match = env.match(/VITE_MAPBOX_API_KEY=(.+)/);
    if (match) key = match[1];
}

const lat = -26.6848;
const lon = 153.1213;

console.log("--- Nominatim ---");
https.get(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`, {
    headers: { 'User-Agent': 'ThalassaMarine/1.0' }
}, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => console.log(JSON.parse(data).address));
});

if (key) {
    console.log("--- Mapbox ---");
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lon},${lat}.json?types=natural_feature,place,locality,neighborhood,district&limit=3&access_token=${key}`;
    https.get(url, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
            const parsed = JSON.parse(data);
            if (parsed.features) {
                parsed.features.forEach(f => console.log(f.place_type, f.text));
            } else {
                console.log(parsed);
            }
        });
    });
}
