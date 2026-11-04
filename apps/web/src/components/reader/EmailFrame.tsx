import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { emailDocument, isSimpleHtml, sanitizeEmailHtml } from '@/lib/sanitize';
import { useIsDark } from '@/hooks/useEnvironment';
import { onAppearanceChange, readToken } from '@/lib/accent';
import type { FrameTheme } from '@/lib/sanitize';
import { cn } from '@/lib/utils';
import { startMailto } from '@/components/compose/startCompose';
import { useTranslation } from 'react-i18next';

/** Couleurs du thème actif pour les mails « simples » (re-calculées à chaque changement de collection, de mode ou d'accent). */
let frameColorsCache: { key: string; value: NonNullable<FrameTheme['colors']> } | null = null;
function snapshotFrameColors() {
  const root = document.documentElement;
  const key = `${root.dataset.theme}|${root.classList.contains('dark')}|${root.style.getPropertyValue('--voxel-accent-strong')}`;
  if (frameColorsCache?.key !== key) {
    frameColorsCache = {
      key,
      value: { text: readToken('--voxel-text-1'), link: readToken('--voxel-accent-strong'), quote: readToken('--voxel-text-2'), quoteLine: readToken('--voxel-line-strong') },
    };
  }
  return frameColorsCache.value;
}
function useFrameColors() {
  return useSyncExternalStore(onAppearanceChange, snapshotFrameColors, snapshotFrameColors);
}

/** Corps HTML d'un mail dans un iframe sandboxé (sans scripts), hauteur auto. */
export function EmailFrame({
  html,
  allowRemote,
  cidMap,
  accountId,
  onBlocked,
}: {
  html: string;
  allowRemote: boolean;
  cidMap: Record<string, string>;
  accountId: string;
  onBlocked?: (n: number) => void;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const { t } = useTranslation('reader');
  const [height, setHeight] = useState(40);
  const dark = useIsDark();
  const simple = useMemo(() => isSimpleHtml(html), [html]);
  const colors = useFrameColors();
  const { doc, blocked } = useMemo(() => {
    const r = sanitizeEmailHtml(html, { allowRemote, cidMap });
    return { doc: emailDocument(r.html, allowRemote, { simple, dark, colors }), blocked: r.blocked };
  }, [html, allowRemote, cidMap, simple, dark, colors]);

  useEffect(() => onBlocked?.(blocked), [blocked, onBlocked]);

  useEffect(() => {
    const iframe = ref.current;
    if (!iframe) return;
    let ro: ResizeObserver | undefined;
    const measure = () => {
      const d = iframe.contentDocument;
      if (!d?.body) return;
      const h = Math.max(d.documentElement.scrollHeight, d.body.scrollHeight);
      setHeight((prev) => (Math.abs(prev - h) > 1 ? h : prev));
    };
    const onLoad = () => {
      const d = iframe.contentDocument;
      if (!d) return;
      measure();
      ro?.disconnect();
      ro = new ResizeObserver(measure);
      ro.observe(d.body);
      d.querySelectorAll('img').forEach((img) => img.addEventListener('load', measure, { once: true }));
      d.addEventListener('click', (ev) => {
        const a = (ev.target as Element | null)?.closest?.('a');
        const href = a?.getAttribute('href') ?? '';
        if (href.toLowerCase().startsWith('mailto:')) {
          ev.preventDefault();
          startMailto(href, accountId);
        }
      });
    };
    iframe.addEventListener('load', onLoad);
    return () => {
      iframe.removeEventListener('load', onLoad);
      ro?.disconnect();
    };
  }, [doc, accountId]);

  return (
    <iframe
      ref={ref}
      title={t('frameTitle')}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={doc}
      className={cn('block w-full border-0', simple ? 'bg-transparent' : 'rounded-lg bg-white ring-1 ring-line dark:ring-0')}
      data-simple={simple || undefined}
      style={{ height }}
      referrerPolicy="no-referrer"
    />
  );
}
