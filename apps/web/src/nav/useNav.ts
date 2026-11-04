import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import { accountsQuery } from '@/lib/mail';
import { deriveNav, type Nav, type RouteSnapshot } from './nav';

/** État de navigation dérivé de l'URL (boîte, dossier, conversation, recherche, filtres, paramètres). */
export function useNav(): Nav {
  // sélection sérialisée : une chaîne ne change que si la route affichée change vraiment
  const key = useRouterState({
    select: (s) => {
      const m = s.matches[s.matches.length - 1];
      return JSON.stringify({ routeId: m?.routeId ?? '', params: m?.params ?? {}, search: m?.search ?? {} });
    },
  });
  const { data: accounts } = useQuery(accountsQuery);
  return useMemo(() => deriveNav(JSON.parse(key) as RouteSnapshot, accounts ?? []), [key, accounts]);
}
