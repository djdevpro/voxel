import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Eye, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/common/bits';
import { setAiSecret, useAiSecretSet } from '@/lib/ai/secrets';
import { cn } from '@/lib/utils';
import { inputCls } from '../ui';

/** Clé d'API chiffrée sur l'appareil : jamais réaffichée une fois enregistrée. */
export function SecretField({ secretId, label, placeholder, optional }: { secretId: string; label: string; placeholder?: string; optional?: boolean }) {
  const { t } = useTranslation('ai');
  const id = useId();
  const saved = useAiSecretSet(secretId);
  const [replacing, setReplacing] = useState(false);
  const [value, setValue] = useState('');
  const [show, setShow] = useState(false);
  const editing = !saved || replacing;

  const save = async () => {
    if (!value.trim()) return;
    await setAiSecret(secretId, value);
    setValue('');
    setShow(false);
    setReplacing(false);
    toast.success(t('settings.secret.saved'));
  };

  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-[12.5px] font-medium text-text-2">
        {label}
        {optional && <span className="ms-1 font-normal text-text-3">{t('settings.secret.optional')}</span>}
      </label>
      {editing ? (
        <div className="flex flex-wrap gap-2">
          <div className="relative min-w-[180px] flex-1">
            <input
              id={id}
              type={show ? 'text' : 'password'}
              autoComplete="off"
              spellCheck={false}
              dir="ltr"
              autoFocus={replacing}
              className={cn(inputCls, 'pe-10 font-mono')}
              value={value}
              placeholder={placeholder}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void save();
                }
              }}
            />
            <IconButton size="sm" label={show ? t('settings.secret.hide') : t('settings.secret.show')} onClick={() => setShow((v) => !v)} className="absolute end-1 top-1">
              {show ? <EyeOff /> : <Eye />}
            </IconButton>
          </div>
          <Button variant="secondary" onClick={save} disabled={!value.trim()}>
            {t('settings.secret.save')}
          </Button>
          {replacing && (
            <Button variant="ghost" onClick={() => setReplacing(false)}>
              {t('settings.secret.cancel')}
            </Button>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <input id={id} disabled value="••••••••••••" dir="ltr" className={cn(inputCls, 'min-w-[180px] flex-1 font-mono opacity-70')} />
          <Button
            variant="secondary"
            onClick={() => {
              setValue('');
              setReplacing(true);
            }}
          >
            {t('settings.secret.replace')}
          </Button>
          <Button variant="ghost" className="text-danger hover:bg-danger/10 hover:text-danger" onClick={() => void setAiSecret(secretId, null)}>
            {t('settings.secret.clear')}
          </Button>
        </div>
      )}
      <span className="mt-1 block text-[11.5px] text-text-3">{t('settings.secret.hint')}</span>
    </div>
  );
}
