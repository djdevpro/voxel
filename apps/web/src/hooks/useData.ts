import { useMemo } from 'react';
import { infiniteQueryOptions, useInfiniteQuery, useQueries, useQuery } from '@tanstack/react-query';
import { accountsQuery, fetchUnifiedPage, identitiesQuery, mailboxesQuery, type ListSpec, type MailboxData, type ThreadItem } from '@/lib/mail';
import { ALL, useUi } from '@/store/ui';
import type { Account } from '@/lib/api';
import { useNav } from '@/nav/useNav';

export function useAccounts() {
  return useQuery(accountsQuery);
}

export function useAccount(id: string | undefined): Account | undefined {
  const { data } = useAccounts();
  return data?.find((a) => a.id === id);
}

export function useMailboxData(accountId: string | undefined) {
  return useQuery({ ...mailboxesQuery(accountId ?? ''), enabled: !!accountId && accountId !== ALL });
}

/** Données de dossiers de tous les comptes, indexées par id de compte. */
export function useAllMailboxData(): { map: Record<string, MailboxData | undefined>; loading: boolean; errors: Record<string, Error> } {
  const { data: accounts } = useAccounts();
  const ids = (accounts ?? []).map((a) => a.id);
  return useQueries({
    queries: ids.map((id) => mailboxesQuery(id)),
    combine: (results) => {
      const map: Record<string, MailboxData | undefined> = {};
      const errors: Record<string, Error> = {};
      ids.forEach((id, i) => {
        map[id] = results[i]?.data;
        if (results[i]?.error) errors[id] = results[i]!.error as Error;
      });
      return { map, loading: results.some((r) => r.isLoading), errors };
    },
  });
}

export function useIdentities(accountId: string | undefined) {
  return useQuery({ ...identitiesQuery(accountId ?? ''), enabled: !!accountId && accountId !== ALL });
}

/** Comptes concernés par la vue courante. */
export function useViewAccounts(): string[] {
  const { data: accounts } = useAccounts();
  const viewAccount = useNav().view.accountId;
  return useMemo(() => {
    if (!accounts) return [];
    if (viewAccount === ALL) return accounts.map((a) => a.id);
    return accounts.some((a) => a.id === viewAccount) ? [viewAccount] : [];
  }, [accounts, viewAccount]);
}

/** Options de la requête paginée d'une liste (partagées avec le préchargement du routeur). */
export function threadsQueryOptions(accounts: string[], spec: ListSpec) {
  const { mailbox, chips, text, quick, sortAsc } = spec;
  return infiniteQueryOptions({
    queryKey: ['threads', { accounts, mailbox, chips, text, quick, sortAsc }] as const,
    queryFn: ({ pageParam }) => fetchUnifiedPage(accounts, spec, pageParam),
    initialPageParam: Object.fromEntries(accounts.map((a) => [a, 0])) as Record<string, number | null>,
    getNextPageParam: (last) => (Object.values(last.next).some((v) => v !== null) ? last.next : undefined),
    enabled: accounts.length > 0,
    staleTime: 20_000,
  });
}

/** Liste paginée des fils pour la vue courante (vue unifiée = fusion par date). */
export function useThreads() {
  const accounts = useViewAccounts();
  const nav = useNav();
  const sortAsc = useUi((s) => s.sortAsc);
  const spec: ListSpec = { mailbox: nav.view.mailbox, chips: nav.search.chips, text: nav.search.text, quick: nav.quick, sortAsc };

  const q = useInfiniteQuery(threadsQueryOptions(accounts, spec));

  const items = useMemo(() => {
    const seen = new Set<string>();
    const out: ThreadItem[] = [];
    for (const p of q.data?.pages ?? []) {
      for (const it of p.items) {
        if (seen.has(it.key)) continue;
        seen.add(it.key);
        out.push(it);
      }
    }
    if (accounts.length > 1) out.sort((a, b) => (sortAsc ? a.receivedAt.localeCompare(b.receivedAt) : b.receivedAt.localeCompare(a.receivedAt)));
    return out;
  }, [q.data, accounts.length, sortAsc]);

  const total = useMemo(() => {
    const first = q.data?.pages[0];
    if (!first) return undefined;
    return Object.values(first.totals).reduce((s, n) => s + n, 0);
  }, [q.data]);

  const errors = q.data?.pages[q.data.pages.length - 1]?.errors ?? {};
  return { ...q, items, total, accountErrors: errors };
}
