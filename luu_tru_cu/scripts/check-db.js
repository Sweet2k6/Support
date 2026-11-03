require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.PGHOST, port: +process.env.PGPORT, database: process.env.PGDATABASE,
  user: process.env.PGUSER, password: process.env.PGPASSWORD,
});
(async () => {
  try {
    const v = await pool.query("SELECT current_database() db, PostGIS_Version() postgis");
    console.log('OK', v.rows[0]);
    for (const t of ['predictions', 'predictions_lstm', 'predictions_transformer']) {
      const r = await pool.query(`SELECT COUNT(*)::int n, array_agg(DISTINCT year) years,
        (SELECT ST_SRID(geom) FROM ${t} LIMIT 1) srid,
        (SELECT GeometryType(geom) FROM ${t} LIMIT 1) gtype,
        (SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE tablename='${t}' AND indexdef ILIKE '%gist%')) gist
        FROM ${t}`);
      console.log(t, r.rows[0]);
    }
    const m = await pool.query('SELECT mo_hinh, nam, round(r2::numeric,3) r2 FROM model_metrics ORDER BY id');
    console.table(m.rows);
  } catch (e) { console.error('ERR', e.message); }
  await pool.end();
})();
