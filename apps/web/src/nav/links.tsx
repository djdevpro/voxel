import type { AnchorHTMLAttributes, Ref } from 'react';
import { Link } from '@tanstack/react-router';
import type { Target } from './nav';

type AnchorProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>;

/**
 * Vrai lien `<a href>` vers une cible de navigation : clic = navigation par le routeur (avec préchargement
 * au survol), Ctrl/⌘+clic ou clic du milieu = nouvel onglet, « copier le lien » du navigateur.
 */
export function RouteLink({
  link,
  state,
  resetScroll,
  ref,
  ...rest
}: AnchorProps & { link: Target | null; state?: Record<string, unknown>; resetScroll?: boolean; ref?: Ref<HTMLAnchorElement> }) {
  if (!link) return <a ref={ref} {...rest} />;
  return (
    <Link
      ref={ref}
      to={link.to as never}
      params={link.params as never}
      search={link.search as never}
      state={state as never}
      resetScroll={resetScroll}
      activeProps={{}}
      {...rest}
    />
  );
}
