/** Shorten a UUID for list/detail display while keeping it recognizable. */
export function truncateId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}