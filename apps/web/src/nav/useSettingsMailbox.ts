import { useQuery } from '@tanstack/react-query';
import { accountsQuery } from '@/lib/mail';
import { useNav } from './useNav';
import { accountByEmail } from './nav';

/** Boîte présélectionnée dans les paramètres : `?mailbox=<adresse>`, sinon la boîte de la vue courante (ou `all`). */
export function useSettingsMailbox(): string {
  const nav = useNav();
  const { data: accounts } = useQuery(accountsQuery);
  return accountByEmail(nav.settingsMailbox, accounts ?? [])?.id ?? nav.view.accountId;
}
