/** Menu de compte (rail) : renommer, couleur, paramètres, se déconnecter de la boîte ou de tout. */
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { inkOn } from '@/lib/accent';
import { useTranslation } from 'react-i18next';
import { Check, LogOut, Palette, PenLine, Settings2, UserPlus, Power } from 'lucide-react';
import { create } from 'zustand';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { mailboxHost, ServerPill } from '@/components/auth/LoginFlow';
import { useSession } from '@/components/auth/session';
import { ACCOUNT_COLORS, type MailboxInfo } from '@/lib/api';
import { openSettings } from '@/nav/nav';
import { inputCls } from '@/components/settings/ui';
import { confirmLogoutAll, confirmLogoutMailbox, updateMailbox } from './mailboxActions';
import { useAddMailbox } from './AddMailboxDialog';

// ------------------------------------------------------------------ renommage

const useRename = create<{ mb: MailboxInfo | null; set: (mb: MailboxInfo | null) => void }>()((set) => ({ mb: null, set: (mb) => set({ mb }) }));

export function RenameMailboxDialog() {
  const { t } = useTranslation('accounts');
  const mb = useRename((s) => s.mb);
  const close = useRename((s) => s.set);
  const [name, setName] = useState('');
  useEffect(() => setName(mb?.displayName ?? ''), [mb]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (mb) void updateMailbox(mb, { displayName: name.trim() });
    close(null);
  };
  return (
    <Dialog open={!!mb} onOpenChange={(o) => !o && close(null)}>
      <DialogContent className="w-[min(400px,94vw)] sm:max-w-none">
        <form onSubmit={submit} className="space-y-4">
          <div>
            <DialogTitle className="text-[15px] font-semibold text-text-1">{t('rename.title')}</DialogTitle>
            <DialogDescription className="mt-1 text-[12.5px] text-text-2 rtl:text-right" dir="ltr">
              {mb?.email}
            </DialogDescription>
          </div>
          <input className={inputCls} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t('rename.placeholder')} aria-label={t('rename.label')} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => close(null)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit">{t('common.save')}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ menu

type Kit = {
  Item: typeof DropdownMenuItem;
  Label: typeof DropdownMenuLabel;
  Separator: typeof DropdownMenuSeparator;
  Sub: typeof DropdownMenuSub;
  SubTrigger: typeof DropdownMenuSubTrigger;
  SubContent: typeof DropdownMenuSubContent;
};

const DROPDOWN: Kit = {
  Item: DropdownMenuItem,
  Label: DropdownMenuLabel,
  Separator: DropdownMenuSeparator,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
};

const CONTEXT = {
  Item: ContextMenuItem,
  Label: ContextMenuLabel,
  Separator: ContextMenuSeparator,
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubContent: ContextMenuSubContent,
} as unknown as Kit;

function MenuItems({ mb, kit }: { mb: MailboxInfo; kit: Kit }) {
  const { t } = useTranslation('accounts');
  const { Item, Label, Separator, Sub, SubTrigger, SubContent } = kit;
  const rename = useRename((s) => s.set);
  const showAdd = useAddMailbox((s) => s.show);
  const { data: session } = useSession();
  const many = (session?.mailboxes.length ?? 0) > 1;
  return (
    <>
      <Label className="flex flex-col gap-1 py-2 font-normal">
        <span className="truncate text-[13px] font-medium text-text-1">{mb.displayName || mb.email}</span>
        {mb.displayName && (
          <span className="truncate text-[11.5px] text-text-3 rtl:text-right" dir="ltr">
            {mb.email}
          </span>
        )}
        <ServerPill protocol={mb.protocol} host={mailboxHost(mb)} className="mt-0.5 self-start" />
      </Label>
      <Separator />
      <Item onSelect={() => setTimeout(() => rename(mb), 80)}>
        <PenLine /> {t('menu.rename')}
      </Item>
      <Sub>
        <SubTrigger>
          <Palette className="me-2 size-4 text-text-3" /> {t('menu.color')}
        </SubTrigger>
        <SubContent className="p-2">
          <div className="grid grid-cols-5 gap-1.5" role="radiogroup" aria-label={t('menu.color')}>
            {ACCOUNT_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={mb.color.toLowerCase() === c}
                aria-label={c}
                onClick={() => void updateMailbox(mb, { color: c })}
                className="flex size-6 items-center justify-center rounded-full outline-none voxel-transition hover:scale-110 focus-visible:ring-2 focus-visible:ring-voxel-accent focus-visible:ring-offset-1"
                style={{ background: c }}
              >
                {mb.color.toLowerCase() === c && <Check className="size-3.5" style={{ color: inkOn(c) }} strokeWidth={3} />}
              </button>
            ))}
          </div>
        </SubContent>
      </Sub>
      <Item onSelect={() => openSettings('accounts')}>
        <Settings2 /> {t('menu.settings')}
      </Item>
      <Item onSelect={() => showAdd()}>
        <UserPlus /> {t('menu.add')}
      </Item>
      <Separator />
      <Item onSelect={() => void confirmLogoutMailbox(mb)}>
        <LogOut className="rtl:-scale-x-100" /> {t('menu.logout')}
      </Item>
      {many && (
        <Item variant="destructive" onSelect={() => void confirmLogoutAll()}>
          <Power /> {t('menu.logoutAll')}
        </Item>
      )}
    </>
  );
}

/** Menu contextuel (clic droit) sur une pastille de boîte. */
export function AccountContextMenu({ mb, children }: { mb: MailboxInfo; children: ReactNode }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-64">
        <MenuItems mb={mb} kit={CONTEXT} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Menu déroulant (bouton de compte en bas du rail). */
export function AccountDropdown({ mb, children, side = 'right' }: { mb: MailboxInfo; children: ReactNode; side?: 'right' | 'left' | 'top' | 'bottom' }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent side={side} align="end" className="w-64">
        <MenuItems mb={mb} kit={DROPDOWN} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
