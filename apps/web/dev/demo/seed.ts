/**
 * Jeux de données de la démo : `work` (alex@acme.demo), `personal` (alex@perso.demo), `studio` (hello@studio.demo)
 * et `generic` (toute autre adresse). Dates calculées par rapport au démarrage, en heure locale : il y a toujours
 * des e-mails « d'aujourd'hui », tous antérieurs à maintenant. Domaines en `.demo` uniquement.
 */
import { randomUUID } from 'node:crypto';
import type { Address, Mailbox, StoredEmail } from './jmap.ts';
import { dataUri, ics, logo, pdf, png } from './files.ts';

export interface SeedSet {
  displayName: string;
  signatureText: string;
  signatureHtml: string;
  mailboxes: Mailbox[];
  blobs: Array<{ id: string; data: Buffer; type: string }>;
  emails: StoredEmail[];
}

interface SeedFile {
  name: string;
  type: string;
  data: Buffer;
}

interface SeedMessage {
  /** Clé locale, pour les réponses. */
  key?: string;
  /** Message auquel celui-ci répond (fil, `inReplyTo`, citation). */
  reply?: string;
  /** Rôle (`inbox`, `sent`…) ou nom d'un dossier personnel. */
  box: string;
  at: Date;
  from: Address;
  to: Address[];
  cc?: Address[];
  subject: string;
  /** Texte brut ; sans `html`, une version HTML simple en est tirée. */
  text?: string;
  /** HTML seul (newsletters) : pas de partie texte. */
  html?: string;
  unread?: boolean;
  flagged?: boolean;
  draft?: boolean;
  files?: SeedFile[];
  unsubscribe?: string;
  headers?: Record<string, string>;
}

interface SeedDef {
  displayName: string;
  signature: string;
  folders: string[];
  messages: SeedMessage[];
}

// ------------------------------------------------------------------ horloge

/** Dates relatives : `today(7, 42)`, `ago(3, 18, 5)`. Une heure d'aujourd'hui dans le futur est ramenée avant maintenant. */
function clock(now: Date) {
  let k = 0;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return {
    today(h: number, m: number): Date {
      const d = new Date(now);
      d.setHours(h, m, 0, 0);
      if (d.getTime() < now.getTime()) return d;
      k++;
      const t = Math.max(now.getTime() - k * 7 * 60_000, Math.min(start.getTime() + k * 60_000, now.getTime() - 1000));
      return new Date(t);
    },
    ago(days: number, h: number, m: number): Date {
      const d = new Date(now);
      d.setDate(d.getDate() - days);
      d.setHours(h, m, 0, 0);
      return d;
    },
    /** Prochain jour de la semaine (0 = dimanche) à l'heure donnée, au moins demain. */
    next(weekday: number, h: number, m: number): Date {
      const d = new Date(now);
      d.setHours(h, m, 0, 0);
      d.setDate(d.getDate() + (((weekday - d.getDay() + 7) % 7) || 7));
      return d;
    },
  };
}

// ------------------------------------------------------------------ construction

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>').replace(/(https:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')}</p>`)
    .join('\n');
}

function wrapHtml(body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;
}

function utc(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const ROLES: Array<[string, string, number]> = [
  ['inbox', 'Inbox', 1], ['drafts', 'Drafts', 2], ['sent', 'Sent', 3], ['archive', 'Archive', 4], ['junk', 'Junk', 5], ['trash', 'Trash', 6],
];

function build(def: SeedDef, owner: string): SeedSet {
  const mailboxes: Mailbox[] = ROLES.map(([role, name, sortOrder]) => ({ id: `mb-${role}`, name, parentId: null, role, sortOrder, isSubscribed: true }));
  def.folders.forEach((name, i) => {
    const [parent, child] = name.split('/') as [string, string | undefined];
    const id = `mb-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    const parentId = child ? `mb-${parent.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : null;
    mailboxes.push({ id, name: child ?? parent, parentId, role: null, sortOrder: 10 + i, isSubscribed: true });
  });
  const boxId = (box: string) => {
    const m = mailboxes.find((x) => x.role === box || x.name === box || x.id === `mb-${box.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`);
    if (!m) throw new Error(`Dossier de démo inconnu : ${box}`);
    return m.id;
  };

  const blobs: SeedSet['blobs'] = [];
  const emails: StoredEmail[] = [];
  const byKey = new Map<string, StoredEmail>();
  const domain = owner.split('@')[1] ?? 'demo';
  def.messages.forEach((m, n) => {
    const id = `e${String(n + 1).padStart(3, '0')}`;
    const parent = m.reply ? byKey.get(m.reply) : undefined;
    if (m.reply && !parent) throw new Error(`Réponse à un message inconnu : ${m.reply}`);
    const keywords: Record<string, true> = {};
    if (!m.unread) keywords.$seen = true;
    if (m.flagged) keywords.$flagged = true;
    if (m.draft) keywords.$draft = true;
    let text = m.text ?? null;
    let html = m.html ?? (m.text !== undefined ? textToHtml(m.text) : null);
    // historique cité, comme le ferait un client de messagerie
    if (parent) {
      const who = `${parent.from?.[0]?.name ?? parent.from?.[0]?.email ?? ''}`;
      const when = new Date(parent.receivedAt).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
      const parentText = parent.text ?? '';
      if (text !== null) text += `\n\nLe ${when}, ${who} a écrit :\n${parentText.split('\n').map((l) => `> ${l}`).join('\n')}`;
      if (html !== null) html += `\n<p>Le ${when}, ${escapeHtml(who)} a écrit :</p>\n<blockquote type="cite">${parent.html ?? textToHtml(parentText)}</blockquote>`;
    }
    if (html !== null && !m.html) html = wrapHtml(html);
    const attachments = (m.files ?? []).map((f, i) => {
      const blobId = `blob-${id}-${i + 1}`;
      blobs.push({ id: blobId, data: f.data, type: f.type });
      return { partId: String(3 + i), blobId, type: f.type, name: f.name, size: f.data.length, disposition: 'attachment', cid: null };
    });
    const messageId = `${id}.${randomUUID().slice(0, 8)}@${m.from.email.split('@')[1] ?? domain}`;
    const email: StoredEmail = {
      id, blobId: `b-${id}`, threadId: parent?.threadId ?? `t-${id}`,
      mailboxIds: { [boxId(m.box)]: true }, keywords,
      receivedAt: utc(m.at), sentAt: utc(new Date(m.at.getTime() - 20_000)),
      messageId: [messageId],
      inReplyTo: parent ? parent.messageId : null,
      references: parent ? [...(parent.references ?? []), ...parent.messageId] : null,
      sender: null, from: [m.from], to: m.to, cc: m.cc ?? null, bcc: null, replyTo: null,
      subject: m.subject, text, html, attachments, headers: { ...(m.headers ?? {}) }, unsubscribe: m.unsubscribe ?? null,
    };
    if (m.key) byKey.set(m.key, email);
    emails.push(email);
  });
  return {
    displayName: def.displayName,
    signatureText: def.signature,
    signatureHtml: `<div>-- <br>${def.signature.split('\n').map(escapeHtml).join('<br>')}</div>`,
    mailboxes,
    blobs,
    emails,
  };
}

const a = (name: string, email: string): Address => ({ name, email });

/** Lien de suivi interminable, comme ceux des campagnes. */
function trackingUrl(target: string, campaign: string): string {
  const token = Buffer.from(`${campaign}:${target}:${'x'.repeat(40)}`).toString('base64url');
  return `https://example.com/click/v2/redirect?cid=${campaign}&uid=8f3a9c2e-71b4-4d0e-9a55-2c6f0e1d9b77&utm_source=newsletter&utm_medium=email&utm_campaign=${campaign}&utm_content=cta_button_primary&sig=${token}&url=${encodeURIComponent(target)}`;
}

const pixel = (id: string) => `<img src="https://example.com/t.gif?u=${id}&e=open&ts=1730000000" width="1" height="1" alt="" style="display:block;border:0">`;

// ------------------------------------------------------------------ jeu « work »

function work(now: Date): SeedDef {
  const c = clock(now);
  const me = a('Alex Martin', 'alex@acme.demo');
  const maya = a('Maya Chen', 'maya.chen@northwind.demo');
  const durand = a('Max Durand', 'max.durand@durand-associes.demo');
  const dupont = a('Max Dupont', 'max.dupont@acme.demo');
  const sarah = a('Sarah Lopez', 'sarah@lopez-conseil.demo');
  const jonas = a('Jonas Weber', 'jonas.weber@studio-k.demo');
  const lena = a('Lena Hoffmann', 'lena@baeckerei-hoffmann.demo');
  const maxime = a('Maxime Martin', 'maxime.martin@freelance.demo');
  const camille = a('Camille Roux', 'camille.roux@acme.demo');
  const payLogo = dataUri(logo([37, 99, 235], [219, 234, 254]));
  const journalLogo = dataUri(logo([24, 24, 27], [250, 204, 21], 28));
  const journalHero = dataUri(png(40, 12, (x, y) => [180 + ((x * 3) % 60), 120 + y * 6, 200 - x * 2]));
  const journalThumb = dataUri(logo([220, 38, 38], [254, 226, 226], 16));
  const payCta = trackingUrl('https://payments.demo/invoices/2026-10', 'invoice_oct');
  const thursday = c.next(4, 10, 0);

  return {
    displayName: 'Alex Martin',
    signature: 'Alex Martin\nChef de projet — Acme\n+33 1 23 45 67 89',
    folders: ['Clients', 'Projets', 'Projets/Northwind'],
    messages: [
      // --- fil Q4 roadmap : Alex hier, Maya ce matin
      {
        key: 'roadmap', box: 'sent', at: c.ago(1, 17, 12), from: me, to: [maya], subject: 'Q4 roadmap — final draft',
        text: 'Hi Maya,\n\nCould you send me the final draft of the Q4 roadmap when it is ready? I would like to go through it before Thursday so we can lock the scope with the team.\n\nThanks!\nAlex',
      },
      {
        reply: 'roadmap', box: 'inbox', at: c.today(7, 40), from: maya, to: [me], subject: 'Re: Q4 roadmap — final draft', unread: true,
        text: 'Hi Alex,\n\nHere is the final draft (attached). The main changes since last week:\n\n- the mobile checkout moves to November,\n- the analytics dashboard is split into two milestones,\n- we added a two-week buffer before the holiday freeze.\n\nCould you review it before our meeting on Thursday? Comments directly in the PDF are fine.\n\nBest,\nMaya',
        files: [{ name: 'roadmap.pdf', type: 'application/pdf', data: pdf('Northwind - Q4 roadmap (final draft)') }],
      },
      {
        box: 'inbox', at: c.today(8, 55), from: durand, to: [me], subject: 'Devis refonte site — validation', unread: true, flagged: true,
        text: 'Bonjour Alex,\n\nVous trouverez ci-joint le devis n° 2026-118 pour la refonte du site : 12 400 € HT, incluant la maquette, l\'intégration et trois mois de maintenance.\n\nPourriez-vous me le valider avant vendredi ? Sans retour de votre part, nous devrons décaler le démarrage à janvier.\n\nBien cordialement,\nMax Durand\nDurand & Associés',
        files: [{ name: 'devis-2026-118.pdf', type: 'application/pdf', data: pdf('Devis 2026-118 - Refonte site - 12 400 EUR HT') }],
      },
      {
        box: 'inbox', at: c.today(9, 10), from: dupont, to: [me], cc: [camille], subject: 'Point hebdo déplacé à jeudi 10h',
        text: 'Salut Alex,\n\nPetit changement : le point hebdo passe à jeudi 10h (salle Ada), mardi ne convenait pas à tout le monde.\n\nMax',
      },
      {
        box: 'inbox', at: c.today(9, 32), from: sarah, to: [me], subject: 'URGENT : paiement bloqué en production', unread: true,
        text: 'Bonjour Alex,\n\nDepuis 8 h ce matin, plus aucun paiement ne passe sur la boutique : les clients reçoivent « Transaction refusée » à la dernière étape. Nous avons déjà perdu une trentaine de commandes.\n\nPouvez-vous me rappeler au plus vite au 06 12 34 56 78 ?\n\nMerci,\nSarah Lopez\nLopez Conseil',
      },
      {
        box: 'inbox', at: c.today(10, 5), from: jonas, to: [me], subject: 'Design review: new onboarding', flagged: true,
        text: 'Hey Alex,\n\nThe new onboarding flow is ready for review: https://example.com/figma/file/onboarding-v3\n\nI mostly need feedback on the three-step progress bar and the empty states. Can we do the review on Wednesday afternoon?\n\nCheers,\nJonas',
      },
      {
        box: 'inbox', at: c.today(11, 20), from: lena, to: [me], subject: 'Nouvelle demande : identité visuelle boulangerie',
        text: 'Bonjour,\n\nJe tiens la Bäckerei Hoffmann à Strasbourg et je cherche une agence pour notre nouvelle identité visuelle : logo, enseigne, sacs et site d\'une page. Budget autour de 8 000 €, et nous aimerions tout avoir dans 6 semaines pour la réouverture.\n\nVielen Dank et à bientôt,\nLena Hoffmann',
      },
      {
        box: 'inbox', at: c.today(12, 3), from: a('GitHub', 'notifications@github.demo'), to: [me], subject: '[acme/web] Pull request #482 merged',
        html: `<!DOCTYPE html><html><body style="font-family:-apple-system,Segoe UI,sans-serif;font-size:14px;color:#24292f">
<p>Merged <a href="https://example.com/acme/web/pull/482">#482</a> into <code>main</code>.</p>
<table cellpadding="8" style="border:1px solid #d0d7de;border-radius:6px"><tr><td><strong>fix(checkout): retry payment intent on timeout</strong><br>
<span style="color:#57606a">camille-roux merged 3 commits · +142 −37</span></td></tr></table>
<p style="color:#57606a;font-size:12px">You are receiving this because you were mentioned. <a href="https://example.com/notifications/unsubscribe">Unsubscribe</a></p></body></html>`,
      },
      {
        box: 'inbox', at: c.today(6, 15), from: a('Payments', 'billing@payments.demo'), to: [me], subject: 'Votre facture d\'octobre est disponible',
        unsubscribe: 'https://example.com/unsubscribe?list=billing', unread: true,
        html: `<!DOCTYPE html><html><head><meta charset="utf-8"><style>.btn{background:#2563eb;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none}</style></head>
<body style="margin:0;background:#f1f5f9"><table width="100%" cellpadding="0" cellspacing="0" role="presentation"><tr><td align="center">
<table width="600" cellpadding="24" cellspacing="0" style="background:#ffffff;font-family:Arial,sans-serif" role="presentation">
<tr><td><img src="${payLogo}" width="48" height="48" alt="Payments"></td></tr>
<tr><td><h1 style="font-size:22px;margin:0">Votre facture d'octobre est disponible</h1>
<p>Bonjour Alex Martin,</p><p>Votre facture n° PAY-2026-10-4471 d'un montant de <strong>89,00 € TTC</strong> est disponible. Elle sera prélevée le 15 du mois.</p>
<p><a class="btn" href="${payCta}">Voir ma facture</a></p></td></tr>
<tr><td style="font-size:11px;color:#64748b">Payments SAS · 10 rue de l'Exemple, Paris · <a href="https://example.com/unsubscribe?list=billing">Se désinscrire</a></td></tr>
</table></td></tr></table>${pixel('acme-alex-oct')}</body></html>`,
      },
      {
        box: 'inbox', at: c.today(8, 2), from: a('Team Calendar', 'calendar@acme.demo'), to: [me], subject: 'Invitation : Weekly sync — jeudi 10:00',
        text: `Max Dupont vous invite à « Weekly sync ».\n\nQuand : jeudi ${thursday.toLocaleDateString('fr-FR')} 10:00 – 11:00\nOù : salle Ada\n\nRépondez depuis l'invitation jointe.`,
        files: [{ name: 'invite.ics', type: 'text/calendar', data: ics('Weekly sync', thursday, 'max.dupont@acme.demo', 'alex@acme.demo') }],
      },
      // --- spams du jour
      {
        box: 'junk', at: c.today(5, 48), from: a('Winner Gifts', 'promo@winner-gifts.demo'), to: [me], subject: 'Félicitations !!! Vous avez gagné un iPhone 17', unread: true,
        html: `<html><body style="background:#fde047;text-align:center;font-family:Impact,sans-serif"><h1 style="color:#dc2626">🎉 FÉLICITATIONS 🎉</h1><p>Vous êtes notre 1 000 000e visiteur ! Réclamez votre iPhone 17 maintenant, il ne reste que <b>3 minutes</b> !</p><p><a href="${trackingUrl('https://winner-gifts.demo/claim', 'iphone17')}" style="font-size:24px">RÉCLAMER MON CADEAU</a></p>${pixel('spam1')}</body></html>`,
      },
      {
        box: 'junk', at: c.today(3, 12), from: a('MoonCoin', 'invest@moon-coin.demo'), to: [me], subject: 'Crypto x100 — last chance', unread: true,
        text: 'Dear investor,\n\nMoonCoin will do x100 before Friday. Only 12 spots left in our private presale. Send your deposit today and become a millionaire.\n\nThis is your LAST CHANCE.',
      },
      // --- hier et avant
      {
        box: 'inbox', at: c.ago(1, 18, 5), from: maxime, to: [me], subject: 'Disponibilités mission de janvier',
        text: 'Bonjour Alex,\n\nSuite à notre échange, je vous confirme mes disponibilités pour la mission de janvier : trois jours par semaine à partir du 6, en télétravail ou chez vous le jeudi.\n\nMon TJM reste à 550 € HT.\n\nBonne soirée,\nMaxime Martin',
      },
      {
        key: 'collab1', box: 'archive', at: c.ago(5, 9, 30), from: durand, to: [me], subject: 'Proposition de collaboration',
        text: 'Bonjour Alex,\n\nNous cherchons une agence partenaire pour la partie front de nos projets en 2027. Seriez-vous ouvert à un premier échange la semaine prochaine ?\n\nCordialement,\nMax Durand',
      },
      {
        key: 'collab2', reply: 'collab1', box: 'sent', at: c.ago(4, 14, 10), from: me, to: [durand], subject: 'Re: Proposition de collaboration',
        text: 'Bonjour Max,\n\nAvec plaisir. Je vous propose mardi à 11 h ou mercredi à 15 h, en visio.\n\nBien à vous,\nAlex',
      },
      {
        reply: 'collab2', box: 'archive', at: c.ago(3, 8, 45), from: durand, to: [me], subject: 'Re: Proposition de collaboration',
        text: 'Mercredi 15 h, parfait. Je vous envoie le lien de la visio et une courte présentation de nos projets.\n\nMax',
      },
      {
        box: 'inbox', at: c.ago(2, 10, 0), from: a('RH Acme', 'rh@acme.demo'), to: [me], subject: 'Rappel : entretiens annuels avant le 30',
        text: 'Bonjour à toutes et à tous,\n\nPetit rappel : les entretiens annuels doivent être réalisés avant le 30. Pensez à remplir votre auto-évaluation dans l\'outil RH et à réserver un créneau avec votre manager.\n\nL\'équipe RH',
      },
      {
        box: 'inbox', at: c.ago(1, 7, 30), from: a('Le Journal du Design', 'hello@journal-design.demo'), to: [me], subject: 'Les 10 tendances typo de l\'hiver',
        unsubscribe: 'https://example.com/unsubscribe?list=journal-design',
        html: `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#fafaf9">
<table width="100%" role="presentation" cellpadding="0" cellspacing="0"><tr><td align="center">
<table width="640" role="presentation" cellpadding="20" cellspacing="0" style="background:#fff;font-family:Georgia,serif">
<tr><td><img src="${journalLogo}" width="56" height="56" alt="Journal du Design"> <span style="font-size:28px;font-weight:bold">Le Journal du Design</span></td></tr>
<tr><td><img src="${journalHero}" width="600" height="180" alt="" style="display:block"></td></tr>
<tr><td><h1>Les 10 tendances typo de l'hiver</h1><p>Des sérifs généreuses au retour des monospaces, notre sélection des caractères qui marqueront la saison.</p>
<p><a href="${trackingUrl('https://journal-design.demo/tendances-typo', 'hiver26')}">Lire l'article</a></p></td></tr>
<tr><td><table role="presentation" cellpadding="8"><tr>
<td><img src="${journalThumb}" width="80" height="80" alt=""><br><a href="${trackingUrl('https://journal-design.demo/portfolio', 'hiver26b')}">Portfolio : 5 studios à suivre</a></td>
<td><img src="${journalThumb}" width="80" height="80" alt=""><br><a href="${trackingUrl('https://journal-design.demo/outils', 'hiver26c')}">Outils : variable fonts en production</a></td>
</tr></table></td></tr>
<tr><td style="font-size:11px;color:#78716c">Vous recevez cet e-mail car vous êtes abonné. <a href="https://example.com/unsubscribe?list=journal-design">Se désinscrire</a></td></tr>
</table></td></tr></table>${pixel('journal-alex')}</body></html>`,
      },
      {
        box: 'inbox', at: c.ago(3, 16, 0), from: a('Northwind Weekly', 'weekly@northwind.demo'), to: [me], subject: 'Northwind Weekly: what shipped this week',
        unsubscribe: 'https://example.com/unsubscribe?list=northwind-weekly',
        html: `<!DOCTYPE html><html><body style="font-family:Helvetica,Arial,sans-serif;max-width:600px;margin:auto">
<h2>What shipped this week</h2><ul><li><b>Faster search</b> — results now load in under 200 ms.</li><li><b>Team roles</b> — invite guests with read-only access.</li><li><b>API v3</b> — webhooks for invoices.</li></ul>
<p><a href="${trackingUrl('https://northwind.demo/changelog', 'weekly45')}">Read the changelog</a></p>
<p style="font-size:11px;color:#888"><a href="https://example.com/unsubscribe?list=northwind-weekly">Unsubscribe</a></p>${pixel('nw-weekly')}</body></html>`,
      },
      {
        box: 'inbox', at: c.ago(4, 15, 25), from: camille, to: [me], subject: 'Retours sur la maquette mobile',
        text: 'Hello Alex,\n\nJ\'ai regardé la maquette mobile : globalement très bien. Trois remarques :\n\n1. le bouton « Payer » est trop bas sur les petits écrans ;\n2. le contraste du texte gris ne passe pas en AA ;\n3. il manque l\'état vide du panier.\n\nJe peux corriger tout ça demain si tu es d\'accord.\n\nCamille',
      },
      // --- plus anciens
      {
        box: 'archive', at: c.ago(16, 11, 0), from: a('Hébergeur Cloud', 'factures@cloud-host.demo'), to: [me], subject: 'Facture hébergement — septembre',
        text: 'Bonjour,\n\nVotre facture d\'hébergement de septembre (149,00 € HT) est jointe.\n\nCloud Host',
        files: [{ name: 'facture-septembre.pdf', type: 'application/pdf', data: pdf('Cloud Host - Facture septembre - 149 EUR HT') }],
      },
      {
        box: 'Clients', at: c.ago(23, 9, 15), from: sarah, to: [me], subject: 'Contrat de maintenance 2027',
        text: 'Bonjour Alex,\n\nNous souhaitons renouveler le contrat de maintenance pour 2027, avec deux jours d\'évolutions par mois en plus. Pouvez-vous nous faire une proposition ?\n\nSarah',
      },
      {
        box: 'Projets/Northwind', at: c.ago(30, 14, 0), from: maya, to: [me], cc: [dupont], subject: 'Kick-off: Northwind web app',
        text: 'Hi team,\n\nThanks for a great kick-off today. Notes and next steps:\n\n- weekly sync on Thursdays,\n- design sprint in two weeks,\n- first release before the end of the quarter.\n\nMaya',
      },
      {
        box: 'archive', at: c.ago(41, 10, 30), from: a('Paris Web Conf', 'speakers@parisweb-conf.demo'), to: [me], subject: 'Your talk has been accepted!',
        text: 'Dear Alex,\n\nWe are happy to let you know that your talk "Accessible checkouts" has been accepted. Please confirm your attendance within two weeks.\n\nThe programme committee',
      },
      {
        box: 'sent', at: c.ago(6, 17, 40), from: me, to: [sarah], subject: 'Compte rendu de la réunion de lancement',
        text: 'Bonjour Sarah,\n\nVoici le compte rendu de notre réunion : refonte du tunnel de commande en deux phases, mise en production de la première phase avant la fin du mois.\n\nBien à vous,\nAlex',
      },
      {
        box: 'drafts', at: c.ago(1, 19, 20), from: me, to: [lena], subject: 'Relance devis Hoffmann', draft: true,
        text: 'Bonjour Lena,\n\nJe reviens vers vous au sujet de\n',
      },
    ],
  };
}

// ------------------------------------------------------------------ jeu « personal »

function personal(now: Date): SeedDef {
  const c = clock(now);
  const me = a('Alex Martin', 'alex@perso.demo');
  const emma = a('Emma Laurent', 'emma.laurent@mail.demo');
  const recipeImg = dataUri(png(32, 20, (x, y) => [230 - y * 3, 140 + x * 2, 60]));
  return {
    displayName: 'Alex Martin',
    signature: 'Alex',
    folders: ['Famille', 'Voyages'],
    messages: [
      {
        key: 'diner', box: 'inbox', at: c.today(8, 20), from: emma, to: [me], subject: 'Dîner samedi ? 🍝', unread: true,
        text: 'Coucou !\n\nÇa te dit un dîner à la maison samedi soir ? Je fais des pâtes fraîches, ramène juste le dessert 😄\n\nBises,\nEmma',
      },
      {
        box: 'inbox', at: c.today(7, 5), from: a('Trail Club', 'club@trail-club.demo'), to: [me], subject: 'Sunday hike: Lake Loop (12 km)',
        text: 'Hi everyone,\n\nThis Sunday we hike the Lake Loop: 12 km, 350 m elevation. Meeting point at the north parking at 8:30. Bring water and a rain jacket.\n\nSee you there!',
      },
      {
        box: 'inbox', at: c.today(6, 30), from: a('Banque Horizon', 'releves@banque-horizon.demo'), to: [me], subject: 'Votre relevé de novembre est disponible',
        text: 'Bonjour,\n\nVotre relevé de compte de novembre est disponible dans votre espace client.\n\nBanque Horizon',
      },
      {
        box: 'Voyages', at: c.today(9, 45), from: a('Rail Express', 'billets@rail-express.demo'), to: [me], subject: 'Votre billet Paris → Lyon du 12/11', unread: true,
        text: 'Bonjour Alex,\n\nVoici votre billet pour le trajet Paris Gare de Lyon → Lyon Part-Dieu du 12/11, départ 8 h 04, voiture 12, place 46.\n\nBon voyage !',
        files: [{ name: 'billet.pdf', type: 'application/pdf', data: pdf('Rail Express - Paris > Lyon - 12/11 - Voiture 12 Place 46') }],
      },
      {
        box: 'inbox', at: c.today(10, 12), from: a('Max Lefèvre', 'max.lefevre@mail.demo'), to: [me], subject: 'Photos du week-end', flagged: true,
        text: 'Salut !\n\nVoilà la photo du sommet, les autres arrivent dans un album partagé.\n\nMax',
        files: [{ name: 'photo.png', type: 'image/png', data: png(1, 1, () => [56, 189, 248]) }],
      },
      {
        box: 'junk', at: c.today(4, 40), from: a('Livraison Colis', 'suivi@colis-express.demo'), to: [me], subject: 'Votre colis est en attente, payez 1,99 €', unread: true,
        text: 'Votre colis n° FR8392 est en attente. Des frais de 1,99 € sont à régler sous 24 h, sinon il sera renvoyé à l\'expéditeur : https://example.com/colis-paiement',
      },
      {
        box: 'Famille', at: c.ago(1, 19, 30), from: a('Maman', 'maman@famille.demo'), to: [me], subject: 'Anniversaire de papa dimanche',
        text: 'Coucou mon grand,\n\nN\'oublie pas l\'anniversaire de papa dimanche midi ! Ta sœur s\'occupe du gâteau, tu peux apporter le vin ?\n\nBisous,\nMaman',
      },
      {
        box: 'inbox', at: c.ago(2, 7, 0), from: a('Cuisine Facile', 'recettes@cuisine-facile.demo'), to: [me], subject: '3 soupes réconfortantes pour novembre',
        unsubscribe: 'https://example.com/unsubscribe?list=cuisine',
        html: `<!DOCTYPE html><html><body style="font-family:Verdana,sans-serif;max-width:560px;margin:auto"><img src="${recipeImg}" width="560" height="200" alt="Soupe">
<h1>3 soupes réconfortantes</h1><p>Potimarron et châtaignes, velouté de poireaux, minestrone express : nos recettes pour les soirées fraîches.</p>
<p><a href="${trackingUrl('https://cuisine-facile.demo/soupes', 'soupes11')}">Voir les recettes</a></p>${pixel('cuisine')}</body></html>`,
      },
      {
        box: 'archive', at: c.ago(5, 13, 10), from: a('Boutique Nordique', 'commandes@boutique-nordique.demo'), to: [me], subject: 'Confirmation de votre commande n° 58213',
        text: 'Merci pour votre commande !\n\n1 × Plaid en laine — 79,00 €\nLivraison prévue sous 3 à 5 jours ouvrés.',
      },
      {
        box: 'archive', at: c.ago(12, 9, 0), from: a('Énergie Verte', 'factures@energie-verte.demo'), to: [me], subject: 'Votre facture d\'électricité',
        text: 'Bonjour,\n\nVotre facture d\'électricité d\'octobre s\'élève à 64,20 €. Elle sera prélevée le 20.\n\nÉnergie Verte',
      },
      {
        box: 'sent', at: c.ago(3, 21, 0), from: me, to: [emma], subject: 'Merci pour hier !',
        text: 'Merci pour la soirée d\'hier, c\'était top ! On remet ça bientôt.\n\nAlex',
      },
    ],
  };
}

// ------------------------------------------------------------------ jeu « studio »

function studio(now: Date): SeedDef {
  const c = clock(now);
  const me = a('Studio Voxel', 'hello@studio.demo');
  return {
    displayName: 'Studio Voxel',
    signature: 'Studio Voxel\nDesign & développement web',
    folders: ['Prospects', 'Fournisseurs'],
    messages: [
      {
        box: 'inbox', at: c.today(8, 10), from: a('Julie Bernard', 'julie@fleurs-bernard.demo'), to: [me], subject: 'Demande de devis site vitrine', unread: true,
        text: 'Bonjour,\n\nJe suis fleuriste à Nantes et j\'aimerais un site vitrine simple (5 pages, galerie, formulaire de contact). Quel serait votre tarif et votre délai ?\n\nJulie Bernard',
      },
      {
        box: 'inbox', at: c.today(9, 25), from: a('Paul Garnier', 'paul.garnier@garnier-btp.demo'), to: [me], subject: 'Retard de livraison', unread: true, flagged: true,
        text: 'Bonjour,\n\nLe site devait être livré lundi et nous n\'avons toujours rien. Nous avons une campagne qui démarre la semaine prochaine. Merci de me donner une date ferme aujourd\'hui.\n\nPaul Garnier',
      },
      {
        box: 'inbox', at: c.today(10, 40), from: a('Nina Park', 'nina@pixelforge.demo'), to: [me], subject: 'Partnership proposal',
        text: 'Hi there,\n\nWe are a small 3D studio and we love your work. Would you be interested in bundling our product renders with your e-commerce sites? Happy to set up a call.\n\nNina',
      },
      {
        box: 'Prospects', at: c.today(7, 15), from: a('Hugo Lambert', 'hugo@cave-lambert.demo'), to: [me], subject: 'Demande de devis site vitrine — cave à vins',
        text: 'Bonjour,\n\nNous ouvrons une cave à vins et voudrions un site avec la carte des vins et les événements. Budget environ 3 000 €.\n\nHugo Lambert',
      },
      {
        box: 'Fournisseurs', at: c.ago(2, 11, 0), from: a('Hébergeur Cloud', 'factures@cloud-host.demo'), to: [me], subject: 'Facture fournisseur n° F-2026-311',
        text: 'Bonjour,\n\nVeuillez trouver ci-jointe la facture F-2026-311 (39,00 € HT).',
        files: [{ name: 'F-2026-311.pdf', type: 'application/pdf', data: pdf('Cloud Host - Facture F-2026-311 - 39 EUR HT') }],
      },
      {
        key: 'relance', box: 'Prospects', at: c.ago(6, 15, 30), from: a('Claire Dubois', 'claire@atelier-dubois.demo'), to: [me], subject: 'Site pour l\'atelier',
        text: 'Bonjour,\n\nAvez-vous pu préparer la proposition pour le site de l\'atelier ?\n\nClaire',
      },
      {
        reply: 'relance', box: 'sent', at: c.ago(5, 9, 5), from: me, to: [a('Claire Dubois', 'claire@atelier-dubois.demo')], subject: 'Re: Site pour l\'atelier',
        text: 'Bonjour Claire,\n\nOui, la proposition part demain matin. Désolé pour l\'attente !\n\nLe Studio',
      },
      {
        box: 'archive', at: c.ago(20, 10, 0), from: a('Design Weekly', 'news@design-weekly.demo'), to: [me], subject: 'Design Weekly #212',
        unsubscribe: 'https://example.com/unsubscribe?list=design-weekly',
        html: `<html><body><h2>Design Weekly #212</h2><p>Color systems, motion tokens and a new icon set.</p><p><a href="${trackingUrl('https://design-weekly.demo/212', 'dw212')}">Read online</a></p>${pixel('dw')}</body></html>`,
      },
    ],
  };
}

// ------------------------------------------------------------------ jeu « generic »

function generic(now: Date, owner: string, name: string): SeedDef {
  const c = clock(now);
  const me = a(name, owner);
  const team = a('Équipe Voxel', 'bienvenue@voxel.demo');
  return {
    displayName: name,
    signature: name,
    folders: [],
    messages: [
      {
        box: 'inbox', at: c.today(8, 0), from: team, to: [me], subject: 'Bienvenue dans la démo Voxel', unread: true,
        text: 'Bonjour,\n\nCette boîte est une démonstration : les messages vivent en mémoire tant que le serveur de développement tourne. Lisez, rangez, supprimez, envoyez : rien ne sort d\'ici.\n\nPour des données plus riches, connectez-vous avec alex@acme.demo, alex@perso.demo ou hello@studio.demo (mot de passe : demo).',
      },
      {
        box: 'inbox', at: c.today(8, 5), from: team, to: [me], subject: 'Essayer l\'assistant IA', unread: true,
        text: 'Ouvrez Paramètres → IA → Ajouter un fournisseur et choisissez « Démo (LLM simulé) ». Ses réponses sont scriptées : idéal pour essayer la recherche conversationnelle, la rédaction assistée et les résumés sans token.',
      },
      {
        box: 'inbox', at: c.ago(1, 9, 0), from: team, to: [me], subject: 'Rechercher comme un pro',
        text: 'La barre de recherche comprend from:, to:, subject:, is:unread, is:flagged, has:attachment, before: et after:. Essayez « is:unread » !',
      },
      {
        box: 'inbox', at: c.ago(2, 9, 0), from: team, to: [me], subject: 'Some English, too',
        text: 'The demo data mixes French and English, so you can check how the AI answers in your interface language.',
      },
      {
        box: 'archive', at: c.ago(7, 9, 0), from: team, to: [me], subject: 'Raccourcis clavier',
        text: 'Appuyez sur « ? » pour voir les raccourcis clavier : j/k pour naviguer, e pour archiver, # pour supprimer.',
      },
    ],
  };
}

// ------------------------------------------------------------------ choix du jeu

export const DEMO_USERS: Record<string, 'work' | 'personal' | 'studio'> = {
  'alex@acme.demo': 'work',
  'alex@perso.demo': 'personal',
  'hello@studio.demo': 'studio',
};

/** Jeu de données d'un identifiant (en minuscules), dates calculées depuis `now`. */
export function seedFor(username: string, now = new Date()): SeedSet {
  const kind = DEMO_USERS[username];
  const local = username.split('@')[0] ?? username;
  const def = kind === 'work' ? work(now) : kind === 'personal' ? personal(now) : kind === 'studio' ? studio(now) : generic(now, username, local);
  return build(def, username);
}
