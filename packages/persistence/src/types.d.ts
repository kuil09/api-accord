import type { Pool } from 'pg';
import type { ReadinessProbe } from '@api-accord/contracts';
export interface PostgresResources {
    readonly pool: Pool;
    readonly readinessProbe: ReadinessProbe;
}
//# sourceMappingURL=types.d.ts.map