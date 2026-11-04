import type { Transition } from 'motion/react';

export const EASE = [0.2, 0.8, 0.2, 1] as const;
export const DUR = { fast: 0.12, base: 0.16, slow: 0.22 } as const;

export const tFast: Transition = { duration: DUR.fast, ease: EASE };
export const tBase: Transition = { duration: DUR.base, ease: EASE };
export const tSlow: Transition = { duration: DUR.slow, ease: EASE };
/** Ressort doux, sans rebond — fenêtres de rédaction */
export const tSpring: Transition = { type: 'spring', bounce: 0, duration: 0.3 };
