const fs = require('fs');

async function main() {
  const q = `[out:json][timeout:30];
relation["name:en"="Ho Chi Minh City"]["admin_level"="4"];
out geom;`;

  try {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: 'data=' + encodeURIComponent(q),
      headers: { 'User-Agent': 'HCMC-GIS-Builder/1.0' }
    });
    const data = await res.json();
    console.log('Overpass returned elements:', data.elements?.length);
    if (data.elements && data.elements.length) {
      fs.writeFileSync('public/data/overpass_hcm.json', JSON.stringify(data.elements[0]));
      console.log('Saved overpass_hcm.json');
    }
  } catch (e) {
    console.error('Overpass error:', e.message);
  }
}

main();
