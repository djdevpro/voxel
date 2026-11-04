import { cn } from '@/lib/utils';

/**
 * Monogramme : enveloppe stylisée dans un carré arrondi.
 * Clair : carré encre, enveloppe couleur du fond. Sombre : carré en surface élevée bordée (jamais un aplat
 * blanc éclatant), enveloppe claire. Le point d'accent suit l'accent lisible de la boîte active.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('voxel-logo size-8', className)} aria-hidden>
      <rect x="0.5" y="0.5" width="31" height="31" rx="8.5" className="voxel-logo-tile" />
      <path d="M8.5 11.5h15v9.5a1.5 1.5 0 0 1-1.5 1.5H10a1.5 1.5 0 0 1-1.5-1.5v-9.5Z" className="voxel-logo-ink" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="m9 12 7 5.5 7-5.5" className="voxel-logo-ink" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="23.5" cy="11" r="3.2" className="voxel-logo-dot" strokeWidth="1.6" />
    </svg>
  );
}
