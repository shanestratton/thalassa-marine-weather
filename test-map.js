import 'dotenv/config';

async function test() {
    const lat = -26.6848;
    const lon = 153.1213;
    const mapboxKey = process.env.VITE_MAPBOX_ACCESS_TOKEN;
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lon},${lat}.json?types=place,locality,neighborhood,district,poi&limit=3&access_token=${mapboxKey}`;
    
    console.log(url.replace(mapboxKey, 'HIDDEN'));

    const res = await fetch(url);
    const data = await res.json();

    if (data.features && data.features.length > 0) {
        for (const place of data.features) {
            const context = place.context || [];
            console.log("\nFeature:", place.place_name, place.place_type);
            
            const city = place.text;
            const isGenericWater = /^(North|South|East|West|Central)?\s*(Pacific|Atlantic|Indian|Arctic|Southern)?\s*(Ocean|Sea)$/i.test(city);
            
            console.log("isGenericWater?", isGenericWater);

            const countryCtx = context.find((c) => c.id.startsWith('country'));
            const regionCtx = context.find((c) => c.id.startsWith('region'));

            const countryShort = countryCtx ? (countryCtx.short_code || countryCtx.text).toUpperCase() : "";

            let state = "";
            if (regionCtx) {
                const regCode = regionCtx.short_code
                    ? regionCtx.short_code.replace(/^[A-Z]{2}-/i, "").toUpperCase()
                    : "";
                if (regCode && regCode.length <= 3) state = regCode;
                else state = regionCtx.text;
            }

            const name = [city, state, countryShort].filter(p => p).join(", ");
            console.log("Resolved Name:", name);
            
            // openmeteo / stormglass generic check:
            const isGeneric = name.startsWith("Location") ||
                /^[+-]?\d/.test(name) ||
                /\b(Ocean|Sea|Reef)\b/i.test(name);
            console.log("isGenericContext (openmeteo rule):", isGeneric);
        }
    } else {
        console.log("No features");
    }
}
test();
