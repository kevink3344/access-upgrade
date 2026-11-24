import sql from 'mssql';
import { env } from './env.js';

/**
 * Connection pool to Azure SQL. Azure drops idle connections, so the pool
 * is configured to tolerate that rather than surfacing it as an error.
 */
const config: sql.config = {
  server: env.AZURE_SQL_SERVER,
  database: env.AZURE_SQL_DATABASE,
  user: env.AZURE_SQL_USER,
  password: env.AZURE_SQL_PASSWORD,
  options: {
    encrypt: true,
    trustServerCertificate: false,
    enableArithAbort: true,
    // Azure SQL closes idle sockets; let the pool re-establish quietly.
    appName: 'project-enlightenment-api',
  },
  pool: {
    min: 0,
    max: 10,
    idleTimeoutMillis: 30_000,
  },
  requestTimeout: 30_000,
  connectionTimeout: 30_000,
};

let pool: sql.ConnectionPool | null = null;

export async function getPool(): Promise<sql.ConnectionPool> {
  if (pool && pool.connected) return pool;

  pool = await new sql.ConnectionPool(config).connect();

  pool.on('error', (err) => {
    console.error('[sql] pool error:', err.message);
  });

  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.close();
    pool = null;
  }
}

/** A parameter value paired with its SQL type. */
export type SqlParam = {
  type: sql.ISqlType | sql.ISqlTypeFactoryWithNoParams;
  value: unknown;
};

/** Binds named parameters onto a request or transaction request. */
export function bindParams(
  request: sql.Request,
  params?: Record<string, SqlParam>,
): sql.Request {
  if (params) {
    for (const [name, { type, value }] of Object.entries(params)) {
      request.input(name, type as sql.ISqlType, value);
    }
  }
  return request;
}

/** Convenience wrapper for a single query. */
export async function query<T = unknown>(
  text: string,
  params?: Record<string, SqlParam>,
): Promise<sql.IResult<T>> {
  const p = await getPool();
  return bindParams(p.request(), params).query<T>(text);
}

/**
 * Convenience wrapper for a single query inside an open transaction.
 *
 * Exists so callers do not have to re-implement parameter binding for
 * `tx.request()`; the transaction itself stays explicit at the call site,
 * which keeps commit/rollback visible where the work happens.
 */
export async function txQuery<T = unknown>(
  tx: sql.Transaction,
  text: string,
  params?: Record<string, SqlParam>,
): Promise<sql.IResult<T>> {
  return bindParams(tx.request(), params).query<T>(text);
}

export { sql };
