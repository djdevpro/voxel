import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function SettingRow({ title, description, children, className }: { title: string; description?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-3 border-b border-line py-4 last:border-0 sm:flex-row sm:items-center sm:justify-between sm:gap-8', className)}>
      <div className="min-w-0">
        <div className="text-[13.5px] font-medium text-text-1">{title}</div>
        {description && <div className="mt-0.5 text-[12.5px] leading-relaxed text-text-2">{description}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function SectionIntro({ children }: { children: ReactNode }) {
  return <p className="mb-4 max-w-[560px] text-[13px] leading-relaxed text-text-2">{children}</p>;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12.5px] font-medium text-text-2">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11.5px] text-text-3">{hint}</span>}
    </label>
  );
}

export const inputCls =
  'h-9 w-full rounded-lg border border-line-strong bg-panel px-3 text-[13.5px] text-text-1 outline-none voxel-transition placeholder:text-text-3 focus:border-voxel-accent focus:ring-[3px] focus:ring-voxel-accent-soft';

export function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: Array<{ value: T; label: string; icon?: ReactNode }> }) {
  return (
    <div role="radiogroup" className="inline-flex rounded-lg bg-black/[0.05] p-0.5 dark:bg-white/[0.06]">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'flex h-7 items-center gap-1.5 rounded-md px-3 text-[12.5px] font-medium voxel-transition [&_svg]:size-3.5',
            value === o.value ? 'bg-panel text-text-1 shadow-soft' : 'text-text-2 hover:text-text-1',
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}
