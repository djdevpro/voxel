import { Toaster } from 'sonner';
import { useSettings } from '@/store/settings';
import { useIsMobile, useMediaQuery } from '@/hooks/useEnvironment';
import { useDirection } from '@/hooks/useDirection';

export function AppToaster() {
  const theme = useSettings((s) => s.theme);
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)');
  const mobile = useIsMobile();
  const dark = theme === 'dark' || (theme === 'system' && systemDark);
  const dir = useDirection();
  return (
    <Toaster
      theme={dark ? 'dark' : 'light'}
      dir={dir}
      position={mobile ? 'top-center' : dir === 'rtl' ? 'bottom-right' : 'bottom-left'}
      visibleToasts={4}
      gap={8}
      // sur ordinateur, décalé au-delà du rail des boîtes (64 px) pour ne pas masquer Paramètres et l'avatar
      offset={mobile ? 12 : dir === 'rtl' ? { bottom: 20, right: 80 } : { bottom: 20, left: 80 }}
      duration={5000}
      closeButton={false}
      toastOptions={{ classNames: { description: '!text-[12.5px] !opacity-75' } }}
    />
  );
}
