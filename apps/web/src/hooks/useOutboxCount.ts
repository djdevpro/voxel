import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/lib/db';

export function useOutboxCount(): number {
  return useLiveQuery(() => db.outbox.count().catch(() => 0), [], 0) ?? 0;
}
