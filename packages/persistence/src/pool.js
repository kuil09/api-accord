import pg, {} from 'pg';
const { Pool: PoolConstructor } = pg;
export function createPostgresPool(databaseUrl, options) {
    return new PoolConstructor({
        connectionString: databaseUrl,
        max: options?.max ?? 5,
        application_name: options?.applicationName ?? 'api-accord'
    });
}
export function createPostgresResources(databaseUrl, options) {
    const pool = createPostgresPool(databaseUrl, options);
    return {
        pool,
        readinessProbe: {
            name: 'postgres',
            check: async () => {
                await pool.query('SELECT 1');
            }
        }
    };
}
//# sourceMappingURL=pool.js.map