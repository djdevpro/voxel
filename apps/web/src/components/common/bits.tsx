import { forwardRef, useRef, type ComponentProps, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { inkOn } from '@/lib/accent';
import { cn } from '@/lib/utils';
import { avatarHue, formatNumber, initials } from '@/lib/format';
import { useTranslation } from 'react-i18next';
import { tBase, tFast } from '@/lib/motion';

/** Compteur qui défile verticalement quand sa valeur change. */
export function AnimatedNumber({ value, className, max = 999 }: { value: number; className?: string; max?: number }) {
  useTranslation(); // re-rendu au changement de langue (chiffres localisés)
  const prev = useRef(value);
  const dir = value >= prev.current ? 1 : -1;
  prev.current = value;
  const label = value > max ? `${formatNumber(max)}+` : formatNumber(value);
  return (
    <span className={cn('relative inline-flex overflow-hidden tabular', className)} aria-label={formatNumber(value)}>
      <AnimatePresence initial={false} mode="popLayout" custom={dir}>
        <motion.span
          key={label}
          custom={dir}
          initial={{ y: dir * 8, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: dir * -8, opacity: 0 }}
          transition={tBase}
          className="inline-block"
        >
          {label}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

export function Kbd({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-[19px] min-w-[19px] items-center justify-center rounded-[5px] border border-line-strong bg-panel px-1 font-sans text-[10.5px] font-medium text-text-2 shadow-[0_1px_0_var(--voxel-line-strong)]',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

interface IconButtonProps extends ComponentProps<'button'> {
  label: string;
  shortcut?: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
  active?: boolean;
  size?: 'sm' | 'md';
}

/** Bouton icône avec info-bulle (et raccourci). */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, shortcut, side = 'bottom', className, children, active, size = 'md', ...props },
  ref,
) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          ref={ref}
          type="button"
          aria-label={label}
          className={cn(
            'inline-flex shrink-0 items-center justify-center rounded-md text-text-2 voxel-transition hover:bg-black/[0.05] hover:text-text-1 active:scale-[0.96] disabled:pointer-events-none disabled:opacity-40 dark:hover:bg-white/[0.07] [&_svg]:size-[17px]',
            size === 'md' ? 'size-8' : 'size-7 [&_svg]:size-[15px]',
            active && 'bg-black/[0.06] text-text-1 dark:bg-white/[0.08]',
            className,
          )}
          {...props}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side={side} className="flex items-center gap-2 border-0 bg-text-1 px-2 py-1 text-[11.5px] text-app shadow-soft">
        {label}
        {shortcut && <span className="rounded bg-white/15 px-1 text-[10.5px] font-medium dark:bg-black/15">{shortcut}</span>}
      </TooltipContent>
    </Tooltip>
  );
});

/** Avatar d'expéditeur (initiales sur teinte déterministe). */
export function SenderAvatar({ name, email, size = 32, className }: { name: string; email: string; size?: number; className?: string }) {
  const hue = avatarHue(email.toLowerCase());
  return (
    <span
      aria-hidden
      className={cn('inline-flex shrink-0 items-center justify-center rounded-full font-semibold select-none', className)}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.38),
        background: `light-dark(oklch(0.93 0.045 ${hue}), oklch(0.32 0.05 ${hue}))`,
        color: `light-dark(oklch(0.42 0.09 ${hue}), oklch(0.86 0.07 ${hue}))`,
      }}
    >
      {initials(name || email)}
    </span>
  );
}

/** Pastille de compte (rail, vue unifiée). */
export function AccountBadge({ color, label, size = 36, className }: { color: string; label: string; size?: number; className?: string }) {
  // initiales blanches ou foncées selon la luminance de la couleur choisie (couleur CSS non analysable → blanc)
  const ink = inkOn(color);
  return (
    <span
      aria-hidden
      className={cn('inline-flex shrink-0 items-center justify-center font-semibold select-none', className)}
      style={{
        color: ink,
        width: size,
        height: size,
        borderRadius: size * 0.32,
        fontSize: Math.round(size * 0.36),
        background: `linear-gradient(160deg, color-mix(in oklab, ${color} 88%, white), ${color})`,
        boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${color} 70%, black 10%), inset 0 1px 0 rgb(255 255 255 / 0.18)`,
      }}
    >
      {initials(label)}
    </span>
  );
}

export function AccountDot({ color, className }: { color: string; className?: string }) {
  return <span aria-hidden className={cn('inline-block size-2 shrink-0 rounded-full', className)} style={{ background: color }} />;
}

/** État vide sobre et illustré. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...tBase, delay: 0.06 }}
      className={cn('flex flex-col items-center justify-center px-8 py-16 text-center', className)}
    >
      <div className="relative mb-5">
        <div className="absolute inset-0 -m-3 rounded-full bg-voxel-accent-softer" />
        <div className="relative flex size-14 items-center justify-center rounded-2xl border border-line bg-panel text-text-3 shadow-soft [&_svg]:size-6">
          {icon}
        </div>
      </div>
      <p className="text-[14.5px] font-medium text-text-1">{title}</p>
      {description && <p className="mt-1 max-w-[280px] text-[13px] leading-relaxed text-text-2">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </motion.div>
  );
}

export function FadeIn({ children, className, delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  return (
    <motion.div className={className} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ ...tFast, delay }}>
      {children}
    </motion.div>
  );
}
