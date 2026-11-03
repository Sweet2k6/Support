require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ host: process.env.PGHOST, port: +process.env.PGPORT, database: process.env.PGDATABASE, user: process.env.PGUSER, password: process.env.PGPASSWORD });
pool.query("SELECT chi_so, MIN(gia_tri) mn, MAX(gia_tri) mx, ROUND(AVG(gia_tri)::numeric,3) avg FROM chi_so_diem WHERE nguon='GEE' AND nam=2025 GROUP BY chi_so")
  .then(r => { console.table(r.rows); pool.end(); });
