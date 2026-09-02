import pg from 'pg';

const { Pool, types } = pg;

// PostgreSQL DATE is a calendar date, not a timestamp. Keep it as YYYY-MM-DD
// so JSON serialization cannot move it to the previous day by timezone offset.
types.setTypeParser(1082, value => value);
export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function query(text, params = []) {
  return pool.query(text, params);
}

export async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
