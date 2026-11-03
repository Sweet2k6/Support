const fs = require('fs');

async function main() {
  // Try Nominatim polygon with details or Overpass
  const queries = [
    'https://nominatim.openstreetmap.org/search?city=Ho+Chi+Minh+City&country=vietnam&format=geojson&polygon_geojson=1&limit=1',
    'https://nominatim.openstreetmap.org/search?q=Thành+phố+Hồ+Chí+Minh&countrycodes=vn&format=geojson&polygon_geojson=1&limit=1'
  ];

  for (const url of queries) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'GIS-TPHCM-App/1.0' } });
      const data = await res.json();
      if (data && data.features && data.features.length) {
        console.log('Got feature from:', url);
        const feat = data.features[0];
        console.log('Geometry type:', feat.geometry.type);
        fs.writeFileSync('public/data/hcm_boundary.geojson', JSON.stringify(feat));
        return;
      }
    } catch (e) {
      console.error('Error fetching from', url, e.message);
    }
  }
}

main();
