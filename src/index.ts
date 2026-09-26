import cluster from 'cluster';
import getLogger from './configs/logger';

/**
 * Entry point. WORKERS=<n> (default 1) forks n gateway processes sharing the port; each worker is
 * a full gateway (Redis-backed limits and cache stay consistent across workers). The primary only
 * supervises: it respawns crashed workers and forwards SIGTERM so every worker drains gracefully.
 */
const workers = Number(process.env.WORKERS) || 1;

if (workers > 1 && cluster.isPrimary) {
  const logger = getLogger();
  let shuttingDown = false;
  for (let i = 0; i < workers; i++) cluster.fork();
  cluster.on('exit', (worker, code, signal) => {
    if (shuttingDown) {
      if (Object.keys(cluster.workers ?? {}).length === 0) process.exit(0);
      return;
    }
    logger.error({ pid: worker.process.pid, code, signal }, 'worker died, respawning');
    cluster.fork();
  });
  const shutdown = () => {
    shuttingDown = true;
    for (const w of Object.values(cluster.workers ?? {})) w?.process.kill('SIGTERM');
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  logger.info({ workers }, 'Sancus primary started');
} else {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('./server');
}
