const fs = require('fs');
const { Pool } = require('pg');
const pool = new Pool({ user: 'postgres', host: 'localhost', database: 'webgis', password: 'tuananh', port: 5432 });

async function load(table, file, valCol) {
  await pool.query(`CREATE TABLE IF NOT EXISTS ${table} (
    longitude DOUBLE PRECISION,
    latitude DOUBLE PRECISION,
    year INT,
    ${valCol} DOUBLE PRECISION
  )`);
  await pool.query(`TRUNCATE ${table}`);
  
  const content = fs.readFileSync(file, 'utf-8');
  const lines = content.split('\n').slice(1).filter(l => l.trim());
  
  let q = `INSERT INTO ${table} (longitude, latitude, year, ${valCol}) VALUES `;
  const vals = [];
  let chunk = [];
  for (let i = 0; i < lines.length; i++) {
    const [y, lon, lat, val] = lines[i].split(',');
    chunk.push(`(${lon}, ${lat}, ${parseInt(y)}, ${val})`);
    if (chunk.length === 5000 || i === lines.length - 1) {
      await pool.query(q + chunk.join(','));
      chunk = [];
    }
  }
  
  await pool.query(`CREATE INDEX IF NOT EXISTS ${table}_geom_idx ON ${table} USING GIST (ST_SetSRID(ST_MakePoint(longitude, latitude), 4326))`);
  console.log(`Loaded ${lines.length} rows into ${table}`);
}

async function run() {
  try {
    await load('ndvi_data', 'd:/gis/ndvi_tphcm_timeseries.csv', 'ndvi');
    await load('tvdi_data', 'd:/gis/tvdi_tphcm_timeseries.csv', 'tvdi');
    console.log('Done');
  } catch (e) {
    console.error(e);
  } finally {
    pool.end();
  }
}
run();
