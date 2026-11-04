import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Loader2, Plus, Star, Trash2 } from 'lucide-react';
import { htmlToText, parseAddressList, formatAddress, type Identity } from '@voxel/jmap';
import { useAccounts, useIdentities } from '@/hooks/useData';
import { ALL } from '@/store/ui';
import { useSettingsMailbox } from '@/nav/useSettingsMailbox';
import { useSettings } from '@/store/settings';
import { getMailboxData, pickIdentity } from '@/lib/mail';
import { jmap } from '@/lib/jmap';
import { RichEditor, type EditorHandle } from '@/components/compose/Editor';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { AccountDot } from '@/components/common/bits';
import { confirmDialog } from '@/store/confirm';
import { Field, SectionIntro, inputCls } from './ui';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '@/lib/api';

export function IdentitiesSection() {
  const { t } = useTranslation('settings');
  const { data: accounts } = useAccounts();
  const viewAccount = useSettingsMailbox();
  const [accountId, setAccountId] = useState(() => (viewAccount !== ALL ? viewAccount : accounts?.[0]?.id ?? ''));
  const account = accounts?.find((a) => a.id === accountId);
  const { data: identities, isLoading } = useIdentities(accountId);
  const defaults = useSettings((s) => s.defaultIdentity);
  const [selected, setSelected] = useState<string | 'new' | null>(null);
  const def = pickIdentity(identities, defaults, accountId, account?.email);

  useEffect(() => {
    if (identities && (!selected || (selected !== 'new' && !identities.some((i) => i.id === selected)))) setSelected(identities[0]?.id ?? 'new');
  }, [identities, selected]);

  const current = selected === 'new' ? null : identities?.find((i) => i.id === selected) ?? null;

  return (
    <div>
      <SectionIntro>{account?.protocol === 'imap' ? t('identities.introImap') : t('identities.intro')}</SectionIntro>
      <div className="mb-4 max-w-xs">
        <Select value={accountId} onValueChange={(v) => { setAccountId(v); setSelected(null); }}>
          <SelectTrigger className="w-full" aria-label={t('identities.mailbox')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(accounts ?? []).map((a) => (
              <SelectItem key={a.id} value={a.id}>
                <AccountDot color={a.color} /> {a.displayName || a.email}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-4 md:grid-cols-[220px_1fr]">
        <div className="space-y-1">
          {isLoading && [0, 1].map((i) => <div key={i} className="voxel-skeleton h-12" />)}
          {(identities ?? []).map((i) => (
            <button
              key={i.id}
              type="button"
              onClick={() => setSelected(i.id)}
              className={cn(
                'flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-start voxel-transition',
                selected === i.id ? 'border-voxel-accent bg-voxel-accent-softer' : 'border-line hover:border-line-strong',
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium text-text-1">{i.name || i.email}</div>
                <div className="truncate text-[11.5px] text-text-3">{i.email}</div>
              </div>
              {def?.id === i.id && <Star className="mt-0.5 size-3.5 shrink-0 fill-flag text-flag" aria-label={t('identities.default')} />}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setSelected('new')}
            className={cn('flex h-10 w-full items-center gap-2 rounded-lg border border-dashed px-3 text-[13px] text-text-2 voxel-transition hover:text-text-1', selected === 'new' ? 'border-voxel-accent' : 'border-line-strong')}
          >
            <Plus className="size-4" /> {t('identities.new')}
          </button>
        </div>
        {selected && accountId && (
          <IdentityEditor key={`${accountId}:${selected}`} accountId={accountId} identity={current} isDefault={def?.id === current?.id} defaultEmail={account?.email ?? ''} onCreated={setSelected} />
        )}
      </div>
    </div>
  );
}

function IdentityEditor({
  accountId,
  identity,
  isDefault,
  defaultEmail,
  onCreated,
}: {
  accountId: string;
  identity: Identity | null;
  isDefault: boolean;
  defaultEmail: string;
  onCreated: (id: string) => void;
}) {
  const { t } = useTranslation('settings');
  const qc = useQueryClient();
  const setSettings = useSettings((s) => s.set);
  const defaults = useSettings((s) => s.defaultIdentity);
  const [name, setName] = useState(identity?.name ?? '');
  const [email, setEmail] = useState(identity?.email ?? defaultEmail);
  const [replyTo, setReplyTo] = useState((identity?.replyTo ?? []).map(formatAddress).join(', '));
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const editor = useRef<EditorHandle>(null);
  const initialSig = identity?.htmlSignature || (identity?.textSignature ? identity.textSignature.replace(/\n/g, '<br>') : '');

  const save = async () => {
    setBusy(true);
    try {
      const data = await getMailboxData(accountId);
      const html = editor.current?.isEmpty() ? '' : (editor.current?.getHTML() ?? '');
      const body: Partial<Identity> = {
        name,
        replyTo: replyTo.trim() ? parseAddressList(replyTo) : null,
        htmlSignature: html,
        textSignature: html ? htmlToText(html) : '',
      };
      const c = jmap(accountId);
      if (identity) {
        const r = await c.call('Identity/set', { accountId: data.jmapAccountId, update: { [identity.id]: body } });
        const err = r.notUpdated?.[identity.id];
        if (err) throw new Error(err.description ?? err.type);
        toast.success(t('identities.saved'));
      } else {
        const r = await c.call('Identity/set', { accountId: data.jmapAccountId, create: { n: { ...body, email: email.trim() } } });
        const err = r.notCreated?.n;
        if (err) throw new Error(err.description ?? err.type);
        toast.success(t('identities.created'));
        if (r.created?.n?.id) onCreated(r.created.n.id);
      }
      setDirty(false);
      await qc.invalidateQueries({ queryKey: ['identities', accountId] });
    } catch (e) {
      toast.error(t('identities.saveFailed'), { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!identity) return;
    const ok = await confirmDialog({ title: t('identities.deleteTitle', { email: identity.email }), confirmLabel: t('identities.delete'), destructive: true });
    if (!ok) return;
    try {
      const data = await getMailboxData(accountId);
      const r = await jmap(accountId).call('Identity/set', { accountId: data.jmapAccountId, destroy: [identity.id] });
      const err = r.notDestroyed?.[identity.id];
      if (err) throw new Error(err.description ?? err.type);
      await qc.invalidateQueries({ queryKey: ['identities', accountId] });
      toast(t('identities.deleted'));
    } catch (e) {
      toast.error(t('identities.deleteFailed'), { description: errorMessage(e) });
    }
  };

  return (
    <div className="space-y-4 rounded-xl border border-line p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('identities.name')}>
          <input className={inputCls} value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }} placeholder={t('identities.namePlaceholder')} />
        </Field>
        <Field label={t('identities.email')} hint={identity ? undefined : t('identities.emailHint')}>
          <input className={cn(inputCls, identity && 'bg-muted text-text-2')} value={email} readOnly={!!identity} onChange={(e) => { setEmail(e.target.value); setDirty(true); }} />
        </Field>
        <div className="sm:col-span-2">
          <Field label={t('identities.replyTo')}>
            <input className={inputCls} value={replyTo} onChange={(e) => { setReplyTo(e.target.value); setDirty(true); }} placeholder={t('identities.replyToPlaceholder')} />
          </Field>
        </div>
      </div>
      <div>
        <span className="mb-1.5 block text-[12.5px] font-medium text-text-2">{t('identities.signature')}</span>
        <div className="rounded-lg border border-line-strong px-3 py-2.5 focus-within:border-voxel-accent focus-within:ring-[3px] focus-within:ring-voxel-accent-soft">
          <RichEditor ariaLabel={t('identities.signature')} handleRef={editor} initialHtml={initialSig} placeholder={t('identities.signaturePlaceholder')} minHeight={90} onChange={() => setDirty(true)} />
        </div>
        <p className="mt-1.5 text-[11.5px] text-text-3">{t('identities.signatureHint')}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button onClick={save} disabled={busy || (!dirty && !!identity)}>
          {busy && <Loader2 className="animate-spin" />}
          {identity ? t('identities.save') : t('identities.create')}
        </Button>
        {identity && !isDefault && (
          <Button variant="outline" onClick={() => setSettings({ defaultIdentity: { ...defaults, [accountId]: identity.id } })}>
            <Star /> {t('identities.makeDefault')}
          </Button>
        )}
        {identity && isDefault && <span className="inline-flex items-center gap-1.5 text-[12.5px] text-text-2"><Star className="size-3.5 fill-flag text-flag" /> {t('identities.isDefault')}</span>}
        <div className="flex-1" />
        {identity?.mayDelete && (
          <Button variant="ghost" className="text-danger hover:bg-danger/10 hover:text-danger" onClick={remove}>
            <Trash2 /> {t('identities.delete')}
          </Button>
        )}
      </div>
    </div>
  );
}
