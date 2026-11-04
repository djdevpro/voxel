import { useState } from 'react';
import { toast } from 'sonner';
import { Download, FileText, FileImage, FileArchive, FileSpreadsheet, File as FileIcon, Eye, X } from 'lucide-react';
import type { EmailBodyPart } from '@voxel/jmap';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { saveBlob, useBlobUrl } from '@/lib/blobs';
import { errorMessage } from '@/lib/api';
import { fileSize } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';

function iconFor(type: string, name: string) {
  if (type.startsWith('image/')) return FileImage;
  if (type === 'application/pdf' || /\.(pdf|docx?|odt|txt|md)$/i.test(name)) return FileText;
  if (/zip|rar|7z|tar|gzip/.test(type) || /\.(zip|rar|7z|tgz|gz)$/i.test(name)) return FileArchive;
  if (/sheet|excel|csv/.test(type) || /\.(xlsx?|ods|csv)$/i.test(name)) return FileSpreadsheet;
  return FileIcon;
}

/** Vignette d'image : téléchargée par fetch authentifié (un `<img src>` ne porte pas `Authorization`). */
function Thumb({ accountId, jmapAccountId, part, name }: { accountId: string; jmapAccountId: string; part: EmailBodyPart; name: string }) {
  const url = useBlobUrl(accountId, jmapAccountId, part.blobId, name, part.type);
  return url ? <img src={url} alt="" className="size-9 shrink-0 rounded-md bg-muted object-cover" /> : <span className="voxel-skeleton size-9 shrink-0 rounded-md" />;
}

/** Enregistre une pièce jointe ; un échec s'affiche en notification. */
function download(accountId: string, jmapAccountId: string, part: EmailBodyPart, name: string) {
  saveBlob(accountId, jmapAccountId, part.blobId!, name, part.type).catch((e) => toast.error(errorMessage(e)));
}

const previewable = (type: string) => type.startsWith('image/') || type === 'application/pdf';

export function Attachments({ parts, accountId, jmapAccountId }: { parts: EmailBodyPart[]; accountId: string; jmapAccountId: string }) {
  const [preview, setPreview] = useState<EmailBodyPart | null>(null);
  const { t } = useTranslation('reader');
  if (!parts.length) return null;
  return (
    <div className="mt-4">
      <div className="mb-2 text-[11.5px] font-medium tracking-wide text-text-3 uppercase">
        {t('attachments.count', { count: parts.length })}
      </div>
      <div className="flex flex-wrap gap-2">
        {parts.map((p, i) => {
          const name = p.name ?? t('attachments.defaultName', { n: i + 1 });
          const Icon = iconFor(p.type, name);
          const isImg = p.type.startsWith('image/') && p.blobId;
          return (
            <div
              key={`${p.blobId}-${i}`}
              className="group relative flex w-[220px] items-center gap-2.5 overflow-hidden rounded-[10px] border border-line bg-panel p-2 pe-2.5 shadow-soft voxel-transition hover:border-line-strong"
            >
              {isImg ? (
                <Thumb accountId={accountId} jmapAccountId={jmapAccountId} part={p} name={name} />
              ) : (
                <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-text-2">
                  <Icon className="size-[18px]" />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px] font-medium text-text-1" title={name} dir="auto">
                  {name}
                </div>
                <div className="text-[11.5px] text-text-3">{fileSize(p.size)}</div>
              </div>
              <div className="flex items-center gap-0.5 opacity-0 voxel-transition group-hover:opacity-100 focus-within:opacity-100">
                {previewable(p.type) && p.blobId && (
                  <button
                    type="button"
                    aria-label={t('attachments.preview', { name })}
                    onClick={() => setPreview(p)}
                    className="flex size-7 items-center justify-center rounded-md text-text-2 hover:bg-accent hover:text-text-1"
                  >
                    <Eye className="size-4" />
                  </button>
                )}
                {p.blobId && (
                  <button
                    type="button"
                    onClick={() => download(accountId, jmapAccountId, p, name)}
                    aria-label={t('attachments.download', { name })}
                    className="flex size-7 items-center justify-center rounded-md text-text-2 hover:bg-accent hover:text-text-1"
                  >
                    <Download className="size-4" />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <Dialog open={!!preview} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent showCloseButton={false} className="flex h-[min(88vh,900px)] w-[min(92vw,1100px)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
          {preview && preview.blobId && <Preview part={preview} accountId={accountId} jmapAccountId={jmapAccountId} onClose={() => setPreview(null)} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Preview({ part, accountId, jmapAccountId, onClose }: { part: EmailBodyPart; accountId: string; jmapAccountId: string; onClose: () => void }) {
  const { t } = useTranslation('reader');
  const name = part.name ?? t('attachments.file');
  // blob local : l'aperçu fonctionne même si le serveur force le téléchargement
  const url = useBlobUrl(accountId, jmapAccountId, part.blobId, name, part.type);
  return (
    <>
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-4">
        <DialogTitle className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{name}</DialogTitle>
        <span className="text-[12px] text-text-3">{fileSize(part.size)}</span>
        <button
          type="button"
          onClick={() => download(accountId, jmapAccountId, part, name)}
          className="flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium text-text-2 hover:bg-accent hover:text-text-1"
        >
          <Download className="size-4" /> {t('attachments.downloadButton')}
        </button>
        <button type="button" onClick={onClose} aria-label={t('common:actions.close')} className="flex size-8 items-center justify-center rounded-md text-text-2 hover:bg-accent">
          <X className="size-4" />
        </button>
      </div>
      <div className={cn('flex min-h-0 flex-1 items-center justify-center bg-muted/50', !url && 'voxel-skeleton rounded-none')}>
        {url && part.type.startsWith('image/') && <img src={url} alt={name} className="max-h-full max-w-full object-contain" />}
        {url && part.type === 'application/pdf' && <iframe src={url} title={name} className="h-full w-full border-0" />}
      </div>
    </>
  );
}
