// Types JMAP (RFC 8620 Core, RFC 8621 Mail, RFC 8887 / Stalwart)

export type Id = string;
export type UTCDate = string;
export type JSONPointer = string;

export const CAP = {
  core: 'urn:ietf:params:jmap:core',
  mail: 'urn:ietf:params:jmap:mail',
  submission: 'urn:ietf:params:jmap:submission',
  vacation: 'urn:ietf:params:jmap:vacationresponse',
  contacts: 'urn:ietf:params:jmap:contacts',
  sieve: 'urn:ietf:params:jmap:sieve',
  quota: 'urn:ietf:params:jmap:quota',
  contactsParse: 'urn:ietf:params:jmap:contacts:parse',
  calendars: 'urn:ietf:params:jmap:calendars',
  calendarsParse: 'urn:ietf:params:jmap:calendars:parse',
  principals: 'urn:ietf:params:jmap:principals',
  /** Web Push avec clé VAPID (RFC 8620 §7.2 + brouillon webpush-vapid). */
  webpush: 'urn:ietf:params:jmap:webpush-vapid',
} as const;

/** Capacité `urn:ietf:params:jmap:webpush-vapid` de la session. */
export interface WebPushVapidCapability {
  /** Clé publique VAPID du serveur (base64url). */
  applicationServerKey: string;
}

/**
 * Abonnement push (RFC 8620 §7.2). Méthodes sans `accountId`. Stalwart v1.0.1 (vérifié le 2026-11-03) :
 * `expires` fixé à 7 jours, `keys` renvoyé à `null` dans `created`, `verificationCode` refusé s'il ne
 * correspond pas (`invalidProperties`).
 */
export interface PushSubscription {
  id: Id;
  deviceClientId: string;
  url: string;
  keys?: { p256dh: string; auth: string } | null;
  verificationCode?: string | null;
  expires?: UTCDate | null;
  types?: string[] | null;
}
export type Capability = (typeof CAP)[keyof typeof CAP] | (string & {});

export interface CoreCapability {
  maxSizeUpload: number;
  maxConcurrentUpload: number;
  maxSizeRequest: number;
  maxConcurrentRequests: number;
  maxCallsInRequest: number;
  maxObjectsInGet: number;
  maxObjectsInSet: number;
  collationAlgorithms: string[];
}

export interface MailAccountCapability {
  maxMailboxesPerEmail: number | null;
  maxMailboxDepth: number | null;
  maxSizeMailboxName: number;
  maxSizeAttachmentsPerEmail: number;
  emailQuerySortOptions: string[];
  mayCreateTopLevelMailbox: boolean;
}

export interface SubmissionAccountCapability {
  maxDelayedSend: number;
  submissionExtensions: Record<string, string[]>;
}

export interface SessionAccount {
  name: string;
  isPersonal: boolean;
  isReadOnly: boolean;
  accountCapabilities: Record<string, unknown>;
}

export interface Session {
  capabilities: Record<string, unknown>;
  accounts: Record<Id, SessionAccount>;
  primaryAccounts: Record<string, Id>;
  username: string;
  apiUrl: string;
  downloadUrl: string;
  uploadUrl: string;
  eventSourceUrl: string;
  state: string;
}

// ---------- Mail ----------

export type MailboxRole =
  | 'inbox'
  | 'archive'
  | 'drafts'
  | 'sent'
  | 'trash'
  | 'junk'
  | 'important'
  | 'all'
  | 'flagged'
  | 'scheduled'
  | 'subscribed'
  | (string & {});

export interface MailboxRights {
  mayReadItems: boolean;
  mayAddItems: boolean;
  mayRemoveItems: boolean;
  maySetSeen: boolean;
  maySetKeywords: boolean;
  mayCreateChild: boolean;
  mayRename: boolean;
  mayDelete: boolean;
  maySubmit: boolean;
}

export interface Mailbox {
  id: Id;
  name: string;
  parentId: Id | null;
  role: MailboxRole | null;
  sortOrder: number;
  totalEmails: number;
  unreadEmails: number;
  totalThreads: number;
  unreadThreads: number;
  myRights: MailboxRights;
  isSubscribed: boolean;
}

export interface EmailAddress {
  name: string | null;
  email: string;
}

export interface EmailAddressGroup {
  name: string | null;
  addresses: EmailAddress[];
}

export interface EmailHeader {
  name: string;
  value: string;
}

export interface EmailBodyPart {
  partId: string | null;
  blobId: Id | null;
  size: number;
  headers?: EmailHeader[];
  name: string | null;
  type: string;
  charset: string | null;
  disposition: string | null;
  cid: string | null;
  language: string[] | null;
  location: string | null;
  subParts?: EmailBodyPart[] | null;
}

export interface EmailBodyValue {
  value: string;
  isEncodingProblem: boolean;
  isTruncated: boolean;
}

export type Keywords = Record<string, boolean>;

export interface Email {
  id: Id;
  blobId: Id;
  threadId: Id;
  mailboxIds: Record<Id, boolean>;
  keywords: Keywords;
  size: number;
  receivedAt: UTCDate;
  messageId: string[] | null;
  inReplyTo: string[] | null;
  references: string[] | null;
  sender: EmailAddress[] | null;
  from: EmailAddress[] | null;
  to: EmailAddress[] | null;
  cc: EmailAddress[] | null;
  bcc: EmailAddress[] | null;
  replyTo: EmailAddress[] | null;
  subject: string | null;
  sentAt: UTCDate | null;
  hasAttachment: boolean;
  preview: string;
  bodyStructure: EmailBodyPart;
  bodyValues: Record<string, EmailBodyValue>;
  textBody: EmailBodyPart[];
  htmlBody: EmailBodyPart[];
  attachments: EmailBodyPart[];
  headers: EmailHeader[];
  /** Propriétés d'en-tête dynamiques, ex. `header:List-Unsubscribe:asURLs` */
  [header: `header:${string}`]: unknown;
}

/** Objet de création d'un Email (Email/set create) */
export interface EmailCreate {
  mailboxIds: Record<Id, boolean>;
  keywords?: Keywords;
  from?: EmailAddress[] | null;
  to?: EmailAddress[] | null;
  cc?: EmailAddress[] | null;
  bcc?: EmailAddress[] | null;
  replyTo?: EmailAddress[] | null;
  sender?: EmailAddress[] | null;
  subject?: string | null;
  sentAt?: UTCDate | null;
  receivedAt?: UTCDate;
  messageId?: string[] | null;
  inReplyTo?: string[] | null;
  references?: string[] | null;
  bodyValues?: Record<string, { value: string; isTruncated?: boolean; isEncodingProblem?: boolean }>;
  textBody?: Partial<EmailBodyPart>[];
  htmlBody?: Partial<EmailBodyPart>[];
  attachments?: Partial<EmailBodyPart>[];
  bodyStructure?: Partial<EmailBodyPart>;
  [header: `header:${string}`]: unknown;
}

export interface Thread {
  id: Id;
  emailIds: Id[];
}

export interface EmailFilterCondition {
  inMailbox?: Id;
  inMailboxOtherThan?: Id[];
  before?: UTCDate;
  after?: UTCDate;
  minSize?: number;
  maxSize?: number;
  allInThreadHaveKeyword?: string;
  someInThreadHaveKeyword?: string;
  noneInThreadHaveKeyword?: string;
  hasKeyword?: string;
  notKeyword?: string;
  hasAttachment?: boolean;
  text?: string;
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
  header?: string[];
}

export interface FilterOperator<C> {
  operator: 'AND' | 'OR' | 'NOT';
  conditions: Array<C | FilterOperator<C>>;
}

export type Filter<C> = C | FilterOperator<C>;

export interface Comparator {
  property: string;
  isAscending?: boolean;
  collation?: string;
  keyword?: string;
}

export interface MailboxFilterCondition {
  parentId?: Id | null;
  name?: string;
  role?: string | null;
  hasAnyRole?: boolean;
  isSubscribed?: boolean;
}

export interface Identity {
  id: Id;
  name: string;
  email: string;
  replyTo: EmailAddress[] | null;
  bcc: EmailAddress[] | null;
  textSignature: string;
  htmlSignature: string;
  mayDelete: boolean;
}

export interface Envelope {
  mailFrom: { email: string; parameters?: Record<string, string | null> | null };
  rcptTo: Array<{ email: string; parameters?: Record<string, string | null> | null }>;
}

export interface EmailSubmission {
  id: Id;
  identityId: Id;
  emailId: Id;
  threadId: Id;
  envelope: Envelope | null;
  sendAt: UTCDate;
  undoStatus: 'pending' | 'final' | 'canceled';
  deliveryStatus: Record<string, unknown> | null;
  dsnBlobIds: Id[];
  mdnBlobIds: Id[];
}

export interface VacationResponse {
  id: 'singleton';
  isEnabled: boolean;
  fromDate: UTCDate | null;
  toDate: UTCDate | null;
  subject: string | null;
  textBody: string | null;
  htmlBody: string | null;
}

export interface SieveScript {
  id: Id;
  name: string | null;
  blobId: Id;
  isActive: boolean;
}

/** Capacité de compte `urn:ietf:params:jmap:sieve` (RFC 9661). */
export interface SieveAccountCapability {
  maxSizeScriptName?: number;
  maxSizeScript?: number | null;
  maxNumberScripts?: number | null;
  maxNumberRedirects?: number | null;
  sieveExtensions: string[];
  notificationMethods?: string[] | null;
  externalLists?: string[] | null;
}

/** Quota (RFC 9425). */
export interface Quota {
  id: Id;
  resourceType: 'count' | 'octets' | (string & {});
  used: number;
  hardLimit: number;
  warnLimit?: number | null;
  softLimit?: number | null;
  scope: 'account' | 'domain' | 'global' | (string & {});
  name: string;
  types: string[];
  description?: string | null;
}

// Contacts (RFC 9610 / JSContact RFC 9553) : types dans `jscontact.ts` (module autonome, partagé avec la passerelle)
import type { AddressBook, ContactCard, ContactCardCreate, ContactCardFilterCondition } from './jscontact.ts';
export type { AddressBook, ContactCard, ContactCardCreate, ContactCardFilterCondition };

// Agendas (draft-ietf-jmap-calendars / JSCalendar RFC 8984) : types dans `jscalendar.ts` (module autonome)
import type { Calendar, CalendarEvent, CalendarEventCreate, CalendarEventFilterCondition } from './jscalendar.ts';
export type { Calendar, CalendarEvent, CalendarEventCreate, CalendarEventFilterCondition };

/** `CalendarEvent/parse` : Stalwart renvoie un tableau d'événements par blob (tous les VEVENT). */
export interface CalendarEventParseResponse {
  accountId: Id;
  parsed?: Record<Id, CalendarEventCreate[] | CalendarEventCreate | null> | null;
  notParsable?: Id[] | null;
  notFound?: Id[] | null;
}

/** `CalendarEvent/query` : `expandRecurrences` (ids synthétiques d'occurrences) et fuseau des dates locales du filtre. */
export interface CalendarEventQueryArgs extends QueryArgs<CalendarEventFilterCondition> {
  expandRecurrences?: boolean;
  timeZone?: string;
}

/** `ContactCard/parse` (RFC 9610 §3.3) : Stalwart renvoie une fiche par blob (la première vCard), la RFC un tableau. */
export interface ContactCardParseResponse {
  accountId: Id;
  parsed?: Record<Id, ContactCardCreate | ContactCardCreate[] | null> | null;
  notParsable?: Id[] | null;
  notFound?: Id[] | null;
}

// ---------- Méthodes génériques ----------

export interface GetArgs<T> {
  accountId: Id;
  ids?: Id[] | null;
  properties?: Array<keyof T & string> | string[] | null;
}
export interface GetResponse<T> {
  accountId: Id;
  state: string;
  list: T[];
  notFound: Id[];
}

export interface ChangesArgs {
  accountId: Id;
  sinceState: string;
  maxChanges?: number | null;
}
export interface ChangesResponse {
  accountId: Id;
  oldState: string;
  newState: string;
  hasMoreChanges: boolean;
  created: Id[];
  updated: Id[];
  destroyed: Id[];
}
export interface MailboxChangesResponse extends ChangesResponse {
  updatedProperties: string[] | null;
}

export interface SetError {
  type: string;
  description?: string;
  properties?: string[];
  [k: string]: unknown;
}

export type PatchObject = Record<string, unknown>;

export interface SetArgs<T, C = Partial<T>> {
  accountId: Id;
  ifInState?: string | null;
  create?: Record<Id, C> | null;
  update?: Record<Id, PatchObject> | null;
  destroy?: Id[] | null;
}
export interface SetResponse<T> {
  accountId: Id;
  oldState: string | null;
  newState: string;
  created: Record<Id, Partial<T> & { id: Id }> | null;
  updated: Record<Id, Partial<T> | null> | null;
  destroyed: Id[] | null;
  notCreated: Record<Id, SetError> | null;
  notUpdated: Record<Id, SetError> | null;
  notDestroyed: Record<Id, SetError> | null;
}

export interface QueryArgs<F> {
  accountId: Id;
  filter?: Filter<F> | null;
  sort?: Comparator[] | null;
  position?: number;
  anchor?: Id | null;
  anchorOffset?: number;
  limit?: number | null;
  calculateTotal?: boolean;
}
export interface QueryResponse {
  accountId: Id;
  queryState: string;
  canCalculateChanges: boolean;
  position: number;
  ids: Id[];
  total?: number;
  limit?: number;
}

export interface QueryChangesArgs<F> {
  accountId: Id;
  filter?: Filter<F> | null;
  sort?: Comparator[] | null;
  sinceQueryState: string;
  maxChanges?: number | null;
  upToId?: Id | null;
  calculateTotal?: boolean;
}
export interface QueryChangesResponse {
  accountId: Id;
  oldQueryState: string;
  newQueryState: string;
  total?: number;
  removed: Id[];
  added: Array<{ id: Id; index: number }>;
}

export interface EmailGetArgs extends GetArgs<Email> {
  bodyProperties?: string[];
  fetchTextBodyValues?: boolean;
  fetchHTMLBodyValues?: boolean;
  fetchAllBodyValues?: boolean;
  maxBodyValueBytes?: number;
}

export interface EmailQueryArgs extends QueryArgs<EmailFilterCondition> {
  collapseThreads?: boolean;
}

export interface MailboxQueryArgs extends QueryArgs<MailboxFilterCondition> {
  sortAsTree?: boolean;
  filterAsTree?: boolean;
}

export interface MailboxSetArgs extends SetArgs<Mailbox> {
  onDestroyRemoveEmails?: boolean;
}

export interface EmailSubmissionSetArgs extends SetArgs<EmailSubmission> {
  onSuccessUpdateEmail?: Record<Id, PatchObject> | null;
  onSuccessDestroyEmail?: Id[] | null;
}

export interface EmailImportArgs {
  accountId: Id;
  emails: Record<Id, { blobId: Id; mailboxIds: Record<Id, boolean>; keywords?: Keywords; receivedAt?: UTCDate }>;
}

export interface SearchSnippet {
  emailId: Id;
  subject: string | null;
  preview: string | null;
}

/** Table des méthodes : nom → [arguments, réponse] */
export interface JmapMethods {
  'Core/echo': [Record<string, unknown>, Record<string, unknown>];
  'Mailbox/get': [GetArgs<Mailbox>, GetResponse<Mailbox>];
  'Mailbox/changes': [ChangesArgs, MailboxChangesResponse];
  'Mailbox/query': [MailboxQueryArgs, QueryResponse];
  'Mailbox/set': [MailboxSetArgs, SetResponse<Mailbox>];
  'Thread/get': [GetArgs<Thread>, GetResponse<Thread>];
  'Thread/changes': [ChangesArgs, ChangesResponse];
  'Email/get': [EmailGetArgs, GetResponse<Email>];
  'Email/changes': [ChangesArgs, ChangesResponse];
  'Email/query': [EmailQueryArgs, QueryResponse];
  'Email/queryChanges': [QueryChangesArgs<EmailFilterCondition> & { collapseThreads?: boolean }, QueryChangesResponse];
  'Email/set': [SetArgs<Email, EmailCreate>, SetResponse<Email>];
  'Email/import': [EmailImportArgs, SetResponse<Email>];
  'PushSubscription/get': [{ ids?: Id[] | null; properties?: string[] | null }, { list: PushSubscription[]; notFound: Id[] | null }];
  'PushSubscription/set': [
    { create?: Record<Id, Omit<PushSubscription, 'id' | 'verificationCode'>> | null; update?: Record<Id, PatchObject> | null; destroy?: Id[] | null },
    { created?: Record<Id, Partial<PushSubscription>> | null; updated?: Record<Id, unknown> | null; destroyed?: Id[] | null; notCreated?: Record<Id, SetError> | null; notUpdated?: Record<Id, SetError> | null; notDestroyed?: Record<Id, SetError> | null },
  ];
  'SearchSnippet/get': [{ accountId: Id; filter?: Filter<EmailFilterCondition> | null; emailIds: Id[] }, { accountId: Id; list: SearchSnippet[]; notFound: Id[] | null }];
  'Identity/get': [GetArgs<Identity>, GetResponse<Identity>];
  'Identity/changes': [ChangesArgs, ChangesResponse];
  'Identity/set': [SetArgs<Identity>, SetResponse<Identity>];
  'EmailSubmission/get': [GetArgs<EmailSubmission>, GetResponse<EmailSubmission>];
  'EmailSubmission/set': [EmailSubmissionSetArgs, SetResponse<EmailSubmission>];
  'VacationResponse/get': [GetArgs<VacationResponse>, GetResponse<VacationResponse>];
  'VacationResponse/set': [SetArgs<VacationResponse>, SetResponse<VacationResponse>];
  'SieveScript/get': [GetArgs<SieveScript>, GetResponse<SieveScript>];
  'SieveScript/set': [
    SetArgs<SieveScript, { name: string; blobId: Id }> & { onSuccessActivateScript?: Id | null; onSuccessDeactivateScript?: boolean },
    SetResponse<SieveScript>,
  ];
  'SieveScript/validate': [{ accountId: Id; blobId: Id }, { accountId: Id; error: SetError | null }];
  'SieveScript/query': [QueryArgs<{ name?: string; isActive?: boolean }>, QueryResponse];
  'SieveScript/changes': [ChangesArgs, ChangesResponse];
  'Quota/get': [GetArgs<Quota>, GetResponse<Quota>];
  'Quota/changes': [ChangesArgs, ChangesResponse];
  'AddressBook/get': [GetArgs<AddressBook>, GetResponse<AddressBook>];
  'AddressBook/changes': [ChangesArgs, ChangesResponse];
  'AddressBook/set': [SetArgs<AddressBook> & { onDestroyRemoveContents?: boolean; onSuccessSetIsDefault?: Id | null }, SetResponse<AddressBook>];
  'ContactCard/get': [GetArgs<ContactCard>, GetResponse<ContactCard>];
  'ContactCard/changes': [ChangesArgs, ChangesResponse];
  'ContactCard/query': [QueryArgs<ContactCardFilterCondition>, QueryResponse];
  'ContactCard/queryChanges': [QueryChangesArgs<ContactCardFilterCondition>, QueryChangesResponse];
  'ContactCard/set': [SetArgs<ContactCard, ContactCardCreate>, SetResponse<ContactCard>];
  'ContactCard/parse': [{ accountId: Id; blobIds: Id[]; properties?: string[] | null }, ContactCardParseResponse];
  'Calendar/get': [GetArgs<Calendar>, GetResponse<Calendar>];
  'Calendar/changes': [ChangesArgs, ChangesResponse];
  'Calendar/set': [SetArgs<Calendar> & { onDestroyRemoveEvents?: boolean; onSuccessSetIsDefault?: Id | null }, SetResponse<Calendar>];
  'CalendarEvent/get': [GetArgs<CalendarEvent> & { recurrenceOverridesBefore?: string; recurrenceOverridesAfter?: string; timeZone?: string }, GetResponse<CalendarEvent>];
  'CalendarEvent/changes': [ChangesArgs, ChangesResponse];
  'CalendarEvent/query': [CalendarEventQueryArgs, QueryResponse];
  'CalendarEvent/set': [SetArgs<CalendarEvent, CalendarEventCreate> & { sendSchedulingMessages?: boolean }, SetResponse<CalendarEvent>];
  'CalendarEvent/parse': [{ accountId: Id; blobIds: Id[]; properties?: string[] | null }, CalendarEventParseResponse];
}

export type MethodName = keyof JmapMethods;
export type ArgsOf<M extends MethodName> = JmapMethods[M][0];
export type ResponseOf<M extends MethodName> = JmapMethods[M][1];

/** Référence arrière (RFC 8620 §3.7) */
export interface ResultReference {
  resultOf: string;
  name: string;
  path: JSONPointer;
}

/** Arguments où chaque propriété peut être remplacée par sa version `#prop` (référence). */
export type WithRefs<A> = {
  [K in keyof A]?: A[K];
} & {
  [K in keyof A as K extends string ? `#${K}` : never]?: ResultReference;
};

export type Invocation = [name: string, args: Record<string, unknown>, callId: string];

export interface JmapRequest {
  using: string[];
  methodCalls: Invocation[];
  createdIds?: Record<Id, Id>;
}

export interface JmapResponse {
  methodResponses: Invocation[];
  createdIds?: Record<Id, Id>;
  sessionState: string;
}

export interface MethodErrorBody {
  type: string;
  description?: string;
  [k: string]: unknown;
}

export interface StateChange {
  '@type': 'StateChange';
  changed: Record<Id, Record<string, string>>;
}

export interface UploadResponse {
  accountId: Id;
  blobId: Id;
  type: string;
  size: number;
}
