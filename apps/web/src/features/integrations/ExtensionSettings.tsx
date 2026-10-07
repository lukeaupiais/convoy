import { useState } from 'react';
import { command, type RuntimeState, type RuntimeCommandInputMap } from '../../shared/api/runtime';

export function ExtensionSettings({ state }: { state: RuntimeState }) {
  const [open, setOpen] = useState(false);
  const [manifest, setManifest] = useState('');
  const [trusted, setTrusted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const extensions = state.capabilities?.extensions ?? [];
  return (
    <section className="extension-settings" aria-label="Plugins and MCP">
      <header className="integration-heading">
        <strong>Registered extensions</strong>
        <button type="button" className="primary" onClick={() => setOpen(true)}>
          Register extension
        </button>
      </header>
      <p>
        Plugin installation and MCP connection setup are not available here. Registered manifests
        use adapters already configured on a runner.
      </p>
      {message && <p role="status">{message}</p>}
      {!extensions.length && <p>No MCP or runner extensions registered.</p>}
      {extensions.map((extension) => (
        <details className="integration-card" key={`${extension.id}@${extension.revision}`}>
          <summary>
            <strong>{extension.id}</strong> ·{' '}
            {extension.kind === 'mcp' ? 'MCP' : 'Runner extension'} · {extension.tools.length} tools
          </summary>
          <p>
            Revision {extension.revision} · Adapter {extension.execution.adapter}
          </p>
          <ul>
            {extension.tools.map((tool) => (
              <li key={tool.id}>
                <strong>{tool.name}</strong> — {tool.description}
              </li>
            ))}
          </ul>
          <details>
            <summary>Manifest</summary>
            <pre>{JSON.stringify(extension, null, 2)}</pre>
          </details>
        </details>
      ))}
      {open && (
        <form
          className="integration-add extension-editor"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setMessage('');
            try {
              const value = JSON.parse(
                manifest,
              ) as RuntimeCommandInputMap['publishExtension']['manifest'];
              await command('publishExtension', {
                organizationId: state.activeContext?.organizationId,
                manifest: value,
                trusted,
              });
              setOpen(false);
              setManifest('');
              setTrusted(false);
              setMessage('Extension registered. Select it in an agent profile to grant access.');
            } catch (error) {
              setMessage((error as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <header className="integration-heading">
            <strong>Register extension</strong>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              Close
            </button>
          </header>
          <label>
            Manifest JSON
            <textarea
              aria-label="Extension manifest"
              value={manifest}
              rows={14}
              required
              onChange={(event) => {
                setManifest(event.target.value);
                setTrusted(false);
              }}
            />
          </label>
          <label className="extension-trust">
            <input
              type="checkbox"
              checked={trusted}
              onChange={(event) => setTrusted(event.target.checked)}
            />
            I reviewed and trust this extension manifest.
          </label>
          <button className="primary" disabled={busy || !trusted}>
            {busy ? 'Registering…' : 'Register'}
          </button>
        </form>
      )}
    </section>
  );
}
