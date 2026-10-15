/**
 * Public surface of @repo/database — the outbound infrastructure clients.
 *
 * Compiled package (design D6): entrypoints point at dist/, source is never
 * exported from the manifest, so a `nest build` downstream follows imports to
 * declarations instead of dragging this tree into its own rootDir.
 */
export { PrismaModule } from './prisma/prisma.module';
export { PrismaService } from './prisma/prisma.service';
export { QueueModule } from './queue/queue.module';
export { WORKER_OPTIONS } from './queue/worker-options';
