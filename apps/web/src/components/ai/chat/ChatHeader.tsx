import { useTranslation } from 'react-i18next';
import { Menu, Sparkles, SquarePen, X } from 'lucide-react';
import { IconButton } from '@/components/common/bits';
import { useIsMobile } from '@/hooks/useEnvironment';
import { shortModelName } from '@/lib/ai/errors';
import { modelRefFor, useAiSettings } from '@/lib/ai/store';
import { useUi } from '@/store/ui';
import { useAiChat } from '@/store/aiChat';

/** En-tête de la colonne en mode discussion. */
export function ChatHeader() {
  const { t } = useTranslation('ai-chat');
  const mobile = useIsMobile();
  const setDrawer = useUi((s) => s.setDrawer);
  const model = useAiSettings((s) => modelRefFor('chat', s)?.model);
  const newChat = useAiChat((s) => s.newChat);
  const closeChat = useAiChat((s) => s.closeChat);

  return (
    <header className="@container shrink-0 border-b border-line">
      <div className="flex h-11 items-center gap-2 px-4">
        {mobile && (
          <IconButton label={t('common:nav.menu')} onClick={() => setDrawer(true)} className="-ms-2">
            <Menu />
          </IconButton>
        )}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Sparkles className="size-4 shrink-0 text-voxel-accent-strong" />
          <h2 className="truncate text-[15px] font-semibold tracking-[-0.01em] text-text-1">{t('header.title')}</h2>
          {model && <span className="hidden truncate text-[12px] text-text-3 @[400px]:inline">{shortModelName(model)}</span>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <IconButton label={t('header.newChat')} onClick={newChat} size="sm">
            <SquarePen />
          </IconButton>
          <IconButton label={t('header.close')} shortcut={t('shortcuts:keys.esc')} onClick={closeChat} size="sm">
            <X />
          </IconButton>
        </div>
      </div>
    </header>
  );
}
