import { useEffect, useRef, useState } from 'react';
import { FileText, Paperclip, X } from 'lucide-react';
import {
  command,
  type ContextFile,
  type RuntimeState,
  type Ticket,
  type TicketScalar,
} from '../../shared/api/runtime';
import { Select } from '../../shared/ui/Select';
import { ExecutionProfileEditor, PlacementEditor } from '../projects';
import { MarkdownDocument } from './ArtifactReview';
import './ticket-details.css';

const fileUrl = (ticketId: number, file: ContextFile) =>
  `/api/tickets/${ticketId}/attachments/${file.id}`;
const fileSize = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.ceil(bytes / 1024)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function TicketFiles({
  ticket,
  editing,
  revisionChanged,
}: {
  ticket: Ticket;
  editing: boolean;
  revisionChanged: (revision: number) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<ContextFile | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(ticket.revision);
  useEffect(() => setRevision(ticket.revision), [ticket.revision]);
  const files = ticket.attachments ?? [];
  async function upload(selected: FileList | null) {
    if (!selected?.length || busy) return;
    setBusy(true);
    setError('');
    let nextRevision = revision;
    try {
      for (const file of Array.from(selected)) {
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1]);
          reader.onerror = () => reject(new Error(`Unable to read ${file.name}.`));
          reader.readAsDataURL(file);
        });
        const response = await command('attachTicketFile', {
          taskId: ticket.id,
          revision: nextRevision,
          name: file.name,
          mime: file.type || 'text/plain',
          data,
        });
        nextRevision = response.result.revision;
      }
      setRevision(nextRevision);
      revisionChanged(nextRevision);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }
  async function remove(file: ContextFile) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const response = await command('removeTicketFile', {
        taskId: ticket.id,
        revision,
        attachmentId: file.id,
      });
      setRevision(response.result.revision);
      revisionChanged(response.result.revision);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!editing && !files.length) return null;
  return (
    <section className="ticket-files" aria-label="Attachments">
      <div className="ticket-file-list">
        {files.map((file) => (
          <div className="ticket-file" key={file.id}>
            <button type="button" onClick={() => setPreview(file)}>
              {file.mime.startsWith('image/') ? (
                <img src={fileUrl(ticket.id, file)} alt="" />
              ) : (
                <FileText size={16} />
              )}
              <span>
                <strong>{file.name}</strong>
                <small>{fileSize(file.size)}</small>
              </span>
            </button>
            {editing && (
              <button
                type="button"
                aria-label={`Remove ${file.name}`}
                disabled={busy}
                onClick={() => void remove(file)}
              >
                <X size={13} />
              </button>
            )}
          </div>
        ))}
      </div>
      {editing && (
        <>
          <input
            ref={input}
            hidden
            type="file"
            multiple
            onChange={(event) => void upload(event.target.files)}
          />
          <button
            type="button"
            className="ticket-attach"
            disabled={busy}
            onClick={() => input.current?.click()}
          >
            <Paperclip size={14} /> {busy ? 'Adding…' : 'Add files'}
          </button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {preview && (
        <div
          className="ticket-file-preview"
          role="dialog"
          aria-modal="true"
          aria-label={preview.name}
          onClick={(event) => {
            if (event.target === event.currentTarget) setPreview(null);
          }}
        >
          <section>
            <header>
              <strong>{preview.name}</strong>
              <a href={fileUrl(ticket.id, preview)} download={preview.name}>
                Download
              </a>
              <button aria-label="Close preview" onClick={() => setPreview(null)}>
                <X size={15} />
              </button>
            </header>
            {preview.mime.startsWith('image/') ? (
              <img src={fileUrl(ticket.id, preview)} alt={preview.name} />
            ) : (
              <iframe title={preview.name} src={fileUrl(ticket.id, preview)} />
            )}
          </section>
        </div>
      )}
    </section>
  );
}

export function TicketDetails({
  state,
  ticket,
  runLabel,
  onRun,
}: {
  state: RuntimeState;
  ticket: Ticket;
  runLabel: string;
  onRun: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [preview, setPreview] = useState(false);
  const [description, setDescription] = useState(ticket.description);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [revision, setRevision] = useState(ticket.revision);
  const [customFields, setCustomFields] = useState<Record<string, TicketScalar>>(() => ({
    ...(ticket.customFields ?? {}),
  }));
  const [newFieldName, setNewFieldName] = useState('');
  const [newFieldValue, setNewFieldValue] = useState('');
  const [fieldError, setFieldError] = useState('');
  useEffect(() => {
    if (!editing) {
      setRevision(ticket.revision);
      setDescription(ticket.description);
    }
  }, [ticket.revision, ticket.description, editing]);
  const patchField = (key: string, value: TicketScalar) =>
    setCustomFields((fields) => ({ ...fields, [key]: value }));
  function removeField(key: string) {
    setCustomFields((fields) => {
      const next = { ...fields };
      delete next[key];
      return next;
    });
  }
  function addField() {
    const key = newFieldName.trim();
    if (!key || !/^[\w-]{1,80}$/.test(key) || Object.hasOwn(customFields, key)) {
      setFieldError(
        !key
          ? 'Enter a field name.'
          : 'Use a unique name with letters, numbers, hyphens or underscores.',
      );
      return;
    }
    patchField(key, newFieldValue);
    setNewFieldName('');
    setNewFieldValue('');
    setFieldError('');
  }
  if (!editing)
    return (
      <section className="ticket-summary">
        <header>
          <h2>{ticket.title}</h2>
          <button className="secondary" onClick={() => setEditing(true)}>
            Edit
          </button>
        </header>
        <div className="ticket-summary-properties">
          <span>{ticket.status}</span>
          <span>{ticket.priority}</span>
          <span>{ticket.agent}</span>
          {ticket.label && <span>{ticket.label}</span>}
        </div>
        {ticket.description && <MarkdownDocument text={ticket.description} />}
        <TicketFiles ticket={ticket} editing={false} revisionChanged={setRevision} />
        <div className="ticket-primary-action">
          <button className="primary" onClick={onRun}>
            {runLabel}
          </button>
        </div>
      </section>
    );
  return (
    <form
      className="runtime-form ticket-edit-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (saving) return;
        setSaving(true);
        setMessage('');
        const form = new FormData(event.currentTarget);
        try {
          const response = await command('updateTicket', {
            taskId: ticket.id,
            revision,
            patch: {
              title: String(form.get('title') ?? ''),
              description,
              label: String(form.get('label') ?? ''),
              priority: String(form.get('priority') ?? '') as Ticket['priority'],
              status: String(form.get('status') ?? ''),
              agent: String(form.get('agent') ?? ''),
              customFields,
            },
          });
          setRevision(response.result.revision);
          setEditing(false);
        } catch (reason) {
          setMessage((reason as Error).message);
        } finally {
          setSaving(false);
        }
      }}
    >
      <label className="ticket-title-field">
        <span>Title</span>
        <textarea name="title" aria-label="Title" defaultValue={ticket.title} required rows={2} />
      </label>
      <div className="ticket-description-editor">
        <div>
          <button
            type="button"
            className={!preview ? 'selected' : ''}
            onClick={() => setPreview(false)}
          >
            Write
          </button>
          <button
            type="button"
            className={preview ? 'selected' : ''}
            onClick={() => setPreview(true)}
          >
            Preview
          </button>
        </div>
        {preview ? (
          <MarkdownDocument text={description} />
        ) : (
          <textarea
            aria-label="Description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        )}
      </div>
      <TicketFiles ticket={ticket} editing revisionChanged={setRevision} />
      <details className="ticket-properties">
        <summary>Properties</summary>
        <div className="ticket-property-grid">
          <label>
            Status
            <Select name="status" defaultValue={ticket.status}>
              {[
                ...new Set(['Backlog', 'Ready', 'In progress', 'In review', 'Done', ticket.status]),
              ].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </Select>
          </label>
          <label>
            Assigned agent
            <Select name="agent" defaultValue={ticket.agent}>
              {[
                ...new Set(['Unassigned', 'Claude Code', 'Codex', 'OpenCode', 'Pi', ticket.agent]),
              ].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </Select>
          </label>
          <label>
            Label
            <input name="label" defaultValue={ticket.label} />
          </label>
          <label>
            Priority
            <Select name="priority" defaultValue={ticket.priority}>
              <option>Low</option>
              <option>Medium</option>
              <option>High</option>
            </Select>
          </label>
        </div>
        <details className="ticket-extra-fields">
          <summary>Custom fields</summary>
          <fieldset className="ticket-custom-fields">
            <legend>Custom fields</legend>
            {Object.entries(customFields).map(([key, value]) => (
              <div className="ticket-custom-field" key={key}>
                <input aria-label={`Custom field ${key} name`} value={key} readOnly />
                <input
                  aria-label={`Custom field ${key} value`}
                  value={String(value ?? '')}
                  onChange={(event) => patchField(key, event.target.value)}
                />
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Remove custom field ${key}`}
                  onClick={() => removeField(key)}
                >
                  ×
                </button>
              </div>
            ))}
            <div className="ticket-custom-field-add">
              <input
                aria-label="New custom field name"
                placeholder="Field name"
                value={newFieldName}
                onChange={(event) => {
                  setNewFieldName(event.target.value);
                  setFieldError('');
                }}
              />
              <input
                aria-label="New custom field value"
                placeholder="Value"
                value={newFieldValue}
                onChange={(event) => setNewFieldValue(event.target.value)}
              />
              <button type="button" className="secondary" onClick={addField}>
                Add
              </button>
            </div>
            {fieldError && <p role="alert">{fieldError}</p>}
          </fieldset>
        </details>
        <details className="runtime-details">
          <summary>Execution environment</summary>
          <ExecutionProfileEditor state={state} target={ticket} ticket />
          <PlacementEditor state={state} target={ticket} ticket />
        </details>
      </details>
      {message && <p role="alert">{message}</p>}
      <div className="ticket-edit-actions">
        <button type="button" className="secondary" onClick={() => setEditing(false)}>
          Cancel
        </button>
        <button className="primary ticket-save" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}
