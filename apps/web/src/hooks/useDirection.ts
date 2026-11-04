import { useTranslation } from 'react-i18next';
import { languageDir } from '@/i18n';

/** Sens d'écriture de la langue courante ; re-rend le composant au changement de langue. */
export function useDirection(): 'ltr' | 'rtl' {
  const { i18n } = useTranslation();
  return languageDir(i18n.resolvedLanguage ?? i18n.language ?? 'en');
}

/** Sens courant hors React (lu sur <html dir>, mis à jour par src/i18n). */
export function documentDir(): 'ltr' | 'rtl' {
  return document.documentElement.dir === 'rtl' ? 'rtl' : 'ltr';
}
