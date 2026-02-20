async function test() {
    const lat = -26.6848;
    const lon = 153.1213;
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`, {
            headers: { 'User-Agent': 'ThalassaMarine/1.0' }
    });
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));

    const addr = data.address || {};
    const locality = addr.suburb || addr.town || addr.city_district || addr.village || addr.city || addr.hamlet || addr.island || addr.municipality || addr.county;
    const stateFull = addr.state || addr.province || addr.region || "";
    const country = addr.country_code ? addr.country_code.toUpperCase() : "";

    let finalName = locality;
    if (!finalName && data.display_name) {
        const parts = data.display_name.split(',').map((p) => p.trim());
        finalName = parts[0];
    }
    const name = [finalName, stateFull, country].filter(p => p && p.trim().length > 0).join(", ");
    console.log("Locality:", locality);
    console.log("State:", stateFull);
    console.log("Country:", country);
    console.log("Resolved Name:", name);

    const isGenericWater = /^(North|South|East|West|Central)?\s*(Pacific|Atlantic|Indian|Arctic|Southern)?\s*(Ocean|Sea)$/i.test(name);
    console.log("isGenericWater?", isGenericWater);
}
test();
