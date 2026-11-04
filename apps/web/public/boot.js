// Script de démarrage (fichier séparé : la CSP « script-src 'self' » interdit les scripts en ligne)
// Thème appliqué avant le rendu pour éviter le flash
try {
  var s = JSON.parse(localStorage.getItem('voxel-settings') || '{}').state || {};
  var t = s.theme || 'system';
  if (t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)) document.documentElement.classList.add('dark');
  if (s.density) document.documentElement.dataset.density = s.density;
} catch (e) {}
// Collection de thèmes appliquée avant le rendu (src/lib/themes.ts la confirme ensuite)
try {
  var th = localStorage.getItem('voxel.theme');
  if (th && /^[a-z-]+$/.test(th)) document.documentElement.dataset.theme = th;
} catch (e) {}
// Langue et sens d'écriture appliqués avant le rendu (src/i18n les met ensuite à jour)
try {
  var l = localStorage.getItem('voxel.lang');
  if (l) {
    document.documentElement.lang = l;
    document.documentElement.dir = l === 'ar' ? 'rtl' : 'ltr';
  }
} catch (e) {}
