/** Sélecteur de boîte des sections de paramètres (même présentation que Répondeur et Expéditeurs bloqués). */
import { useState } from 'react';
import type { MailboxInfo } from '@/lib/api';
import { ALL } from '@/store/ui';
import { useSettingsMailbox } from '@/nav/useSettingsMailbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AccountDot } from '@/components/common/bits';

/** Boîte choisie : celle de la vue (ou de `?mailbox=`) si elle convient, sinon la première. */
export function usePickedMailbox(accounts: MailboxInfo[]): [string, (id: string) => void] {
  const viewAccount = useSettingsMailbox();
  const [picked, setPicked] = useState(() => (viewAccount !== ALL && accounts.some((a) => a.id === viewAccount) ? viewAccount : ''));
  const id = accounts.some((a) => a.id === picked) ? picked : (accounts[0]?.id ?? '');
  return [id, setPicked];
}

export function MailboxPicker({ accounts, value, onChange, label }: { accounts: MailboxInfo[]; value: string; onChange: (id: string) => void; label: string }) {
  if (accounts.length < 2) return null;
  return (
    <div className="mb-5 max-w-xs">
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-full" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {accounts.map((a) => (
            <SelectItem key={a.id} value={a.id}>
              <AccountDot color={a.color} /> {a.displayName || a.email}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
