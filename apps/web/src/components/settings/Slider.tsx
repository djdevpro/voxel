import { Slider as SliderPrimitive } from 'radix-ui';
import { useTranslation } from 'react-i18next';
import { useDirection } from '@/hooks/useDirection';

export function Slider({
  value,
  onChange,
  min,
  max,
  step,
  label,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
  /** Nom accessible ; par défaut « Délai » (common:slider.delay). */
  label?: string;
}) {
  const { t } = useTranslation();
  // sens explicite : en arabe la piste se remplit de droite à gauche et les flèches suivent
  const dir = useDirection();
  return (
    <SliderPrimitive.Root
      dir={dir}
      value={[value]}
      onValueChange={(v) => onChange(v[0] ?? value)}
      min={min}
      max={max}
      step={step}
      className="relative flex h-5 w-full touch-none items-center select-none"
      aria-label={label ?? t('slider.delay')}
    >
      <SliderPrimitive.Track className="relative h-1 w-full grow overflow-hidden rounded-full bg-line-strong">
        <SliderPrimitive.Range className="absolute h-full bg-voxel-accent" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb className="block size-4 rounded-full border border-line-strong bg-panel shadow-soft voxel-transition hover:scale-110 active:scale-105 focus-visible:border-voxel-accent focus-visible:ring-[3px] focus-visible:ring-voxel-accent-soft focus-visible:outline-none dark:bg-text-1" />
    </SliderPrimitive.Root>
  );
}
