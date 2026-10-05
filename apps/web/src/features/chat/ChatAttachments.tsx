import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AtSign, FileText, Paperclip, X } from 'lucide-react';
import { command, type ContextFile } from '../../shared/api/runtime';
import { useDetailsPopover } from '../../shared/ui/useDetailsPopover';
import { WorkflowArtifactContent } from '../workflows';

const url = (sessionId: string, file: ContextFile) =>
  `/api/context/${encodeURIComponent(sessionId)}/${file.id}`;
const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.ceil(bytes / 1024)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
export function AttachmentList({
  sessionId,
  files,
  remove,
  disabled = false,
}: {
  sessionId: string;
  files: ContextFile[];
  remove?: (id: string) => void;
  disabled?: boolean;
}) {
  const [preview, setPreview] = useState<ContextFile | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!preview) return;
    dialog.current?.showModal();
    setText('');
    setError('');
    const controller = new AbortController();
    const mime = preview.mime.split(';')[0].trim().toLowerCase();
    const isMarkdown = mime === 'text/markdown' || (!mime && /\.md(?:own)?$/i.test(preview.name));
    const isPlain = mime === 'text/plain';
    const isJson = mime === 'application/json' || mime.endsWith('+json');
    if (isMarkdown || isPlain || isJson)
      void fetch(url(sessionId, preview), { signal: controller.signal })
        .then(async (r) => {
          if (!r.ok) throw new Error('File unavailable. Reattach it before sending.');
          const contents = await r.text();
          if (isJson) {
            try {
              setText(JSON.stringify(JSON.parse(contents), null, 2));
            } catch {
              setText(contents);
            }
          } else setText(contents);
        })
        .catch((e) => {
          if (!controller.signal.aborted) setError(e.message);
        });
    return () => controller.abort();
  }, [preview, sessionId]);
  return (
    <>
      <div
        className="attachment-list"
        aria-label={remove ? 'Selected context' : 'Message attachments'}
      >
        {files.map((f) => (
          <div className="attachment-chip" key={f.id}>
            <button
              type="button"
              onClick={() => setPreview(f)}
              title={f.source ? `${f.source.path} · snapshot from ${f.source.runnerId}` : f.name}
            >
              {f.mime.startsWith('image/') ? (
                <img src={url(sessionId, f)} alt="" />
              ) : (
                <FileText size={18} />
              )}
              <span>
                <strong>{f.source ? `@${f.source.path}` : f.name}</strong>
                <small>
                  {f.source ? 'Workspace snapshot · ' : ''}
                  {size(f.size)}
                </small>
              </span>
            </button>
            {remove && (
              <button
                type="button"
                className="remove-attachment"
                aria-label={`Remove ${f.name}`}
                disabled={disabled}
                onClick={() => remove(f.id)}
              >
                <X size={14} />
              </button>
            )}
          </div>
        ))}
      </div>
      {preview && (
        <dialog
          ref={dialog}
          className="attachment-preview"
          onClose={() => setPreview(null)}
          onClick={(e) => {
            if (e.target === e.currentTarget) dialog.current?.close();
          }}
        >
          <header>
            <strong>{preview.name}</strong>
            <a href={url(sessionId, preview)} download={preview.name}>
              Download
            </a>
            <button
              type="button"
              aria-label="Close file preview"
              onClick={() => dialog.current?.close()}
            >
              <X size={18} />
            </button>
          </header>
          {preview.source && (
            <p>
              Snapshot of {preview.source.path} · {preview.source.runnerId}
            </p>
          )}
          {error ? (
            <p role="alert">{error}</p>
          ) : preview.mime.startsWith('image/') ? (
            <img
              src={url(sessionId, preview)}
              alt={preview.name}
              onError={() => setError('Image preview unavailable.')}
            />
          ) : ['text/markdown', 'text/plain', 'application/json'].includes(
              preview.mime.split(';')[0].trim().toLowerCase(),
            ) ||
            preview.mime.split(';')[0].trim().toLowerCase().endsWith('+json') ||
            (!preview.mime && /\.md(?:own)?$/i.test(preview.name)) ? (
            preview.mime.split(';')[0].trim().toLowerCase() === 'text/markdown' ||
            (!preview.mime && /\.md(?:own)?$/i.test(preview.name)) ? (
              <WorkflowArtifactContent text={text || 'Loading…'} />
            ) : (
              <pre>{text || 'Loading…'}</pre>
            )
          ) : (
            <div>
              <p>Preview is unavailable for this content type.</p>
              <p>
                {preview.mime || 'Unknown content type'} · {size(preview.size)}
              </p>
            </div>
          )}
          <small>SHA-256 {preview.hash}</small>
        </dialog>
      )}
    </>
  );
}

export function AttachmentComposer({
  sessionId,
  files,
  onChange,
  onError,
  onBusy,
  disabled,
  workspace,
  children,
}: {
  sessionId: string;
  files: ContextFile[];
  onChange: (files: ContextFile[]) => void;
  onError: (message: string) => void;
  onBusy: (busy: boolean) => void;
  disabled: boolean;
  workspace: boolean;
  children: (toolbar: ReactNode) => ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  const lock = useRef(false);
  const menu = useDetailsPopover();
  const [busy, setBusy] = useState(false);
  const [reference, setReference] = useState(false);
  const [path, setPath] = useState('');
  const [dragging, setDragging] = useState(false);
  async function attach(upload: File[] | string) {
    if (disabled || lock.current) return;
    lock.current = true;
    setBusy(true);
    onBusy(true);
    onError('');
    const added = [...files];
    try {
      if (added.length + (typeof upload === 'string' ? 1 : upload.length) > 4)
        throw new Error('Choose up to four attachments per message.');
      await command('claim', { sessionId, label: 'Web chat' });
      if (typeof upload === 'string') {
        const { result } = await command('attachContext', {
          sessionId,
          path: upload.trim().replace(/^@/, ''),
        });
        if (!added.some((f) => f.id === result.id)) added.push(result);
        setReference(false);
        setPath('');
      } else
        for (const file of upload) {
          if (!file.size || file.size > 4 * 1024 * 1024)
            throw new Error(`${file.name}: choose a non-empty file up to 4 MB (text: 64 KB).`);
          const data = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(',')[1]);
            reader.onerror = () => reject(new Error(`Unable to read ${file.name}`));
            reader.readAsDataURL(file);
          });
          const { result } = await command('attachContext', {
            sessionId,
            name: file.name,
            mime: file.type,
            data,
          });
          if (!added.some((f) => f.id === result.id)) added.push(result);
        }
    } catch (e) {
      onError((e as Error).message);
    } finally {
      onChange(added);
      lock.current = false;
      setBusy(false);
      onBusy(false);
    }
  }
  return (
    <div
      className={`attachment-composer${dragging ? ' is-dragging' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(e) => {
        if (e.dataTransfer.files.length) {
          e.preventDefault();
          setDragging(false);
          void attach(Array.from(e.dataTransfer.files));
        }
      }}
      onPaste={(e) => {
        const pasted = Array.from(e.clipboardData.files);
        if (pasted.length) {
          e.preventDefault();
          void attach(pasted);
        }
      }}
    >
      {!!files.length && (
        <AttachmentList
          sessionId={sessionId}
          files={files}
          disabled={disabled || busy}
          remove={(id) => onChange(files.filter((f) => f.id !== id))}
        />
      )}
      {reference && (
        <form
          className="workspace-reference"
          onSubmit={(e) => {
            e.preventDefault();
            void attach(path);
          }}
        >
          <label htmlFor={`context-path-${sessionId}`} className="sr-only">
            Workspace file path
          </label>
          <input
            id={`context-path-${sessionId}`}
            autoFocus
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="src/example.ts"
            maxLength={500}
          />
          <button type="submit" disabled={disabled || busy || !path.trim()}>
            Attach snapshot
          </button>
          <button
            type="button"
            aria-label="Cancel file reference"
            onClick={() => setReference(false)}
          >
            <X size={16} />
          </button>
          <small>Relative to this session’s workspace · text files up to 64 KB</small>
        </form>
      )}
      {children(
        <div className="attachment-toolbar">
          <input
            ref={input}
            type="file"
            multiple
            hidden
            accept="image/png,image/jpeg,image/webp,.txt,.md,.csv,.tsv,.json,.yaml,.yml,.toml,.xml,.html,.css,.js,.jsx,.ts,.tsx,.py,.go,.rs,.java,.c,.cpp,.h,.sh,.sql,.log,.diff,.patch"
            onChange={(e) => {
              void attach(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
          <details className="composer-popover attachment-menu" ref={menu}>
            <summary
              aria-label="Attach context"
              title="Attach context"
              aria-disabled={disabled || busy || files.length >= 4}
              onClick={(e) => {
                if (disabled || busy || files.length >= 4) e.preventDefault();
              }}
            >
              <Paperclip size={17} />
            </summary>
            <div className="composer-popover-panel">
              <button
                type="button"
                disabled={disabled || busy || files.length >= 4}
                onClick={() => {
                  if (menu.current) menu.current.open = false;
                  input.current?.click();
                }}
              >
                <Paperclip size={16} /> Files or images
              </button>
              {workspace && (
                <button
                  type="button"
                  disabled={disabled || busy || files.length >= 4}
                  onClick={() => {
                    if (menu.current) menu.current.open = false;
                    setReference(true);
                  }}
                >
                  <AtSign size={16} /> Workspace file
                </button>
              )}
            </div>
          </details>
          {busy && <span role="status">Adding context…</span>}
          {dragging && <span>Drop files to attach</span>}
        </div>,
      )}
    </div>
  );
}
