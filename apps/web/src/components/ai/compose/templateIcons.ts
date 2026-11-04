import {
  BriefcaseBusiness,
  Languages,
  Mic,
  Minimize2,
  Reply,
  Smile,
  Sparkles,
  SpellCheck,
  WandSparkles,
  type LucideIcon,
} from 'lucide-react';

/** Icônes des modèles de prompts de l'éditeur (champ `icon`). */
export const TEMPLATE_ICONS: Record<string, LucideIcon> = {
  SpellCheck,
  WandSparkles,
  Minimize2,
  BriefcaseBusiness,
  Smile,
  Reply,
  Mic,
  Languages,
  Sparkles,
};

export function templateIcon(name: string | undefined): LucideIcon {
  return (name && TEMPLATE_ICONS[name]) || Sparkles;
}
