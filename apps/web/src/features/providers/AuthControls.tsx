import { useState } from 'react';
import { api, type RuntimeState } from '../../shared/api/runtime';

export function AuthControls({ state }: { state: RuntimeState }) {
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  async function act(action: 'login' | 'disconnect') {
    setWorking(true);
    setError('');
    try {
      await api(`/api/auth/${action}`, {});
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setWorking(false);
    }
  }
  const device = state.auth.device;
  return (
    <details className="runtime-details">
      <summary>Codex subscription · {state.auth.connected ? 'connected' : 'not connected'}</summary>
      <div className="runtime-toolbar">
        <button
          className="secondary"
          disabled={working || ['starting', 'waiting'].includes(device.state)}
          onClick={() => act('login')}
        >
          Sign in
        </button>
        <button className="secondary" disabled={working} onClick={() => act('disconnect')}>
          Disconnect
        </button>
      </div>
      <p>
        Convoy signs in directly, stores the credential privately on this daemon, and refreshes it
        here. No CLI, third-party harness, or API key is used.
      </p>
      {device.state === 'waiting' && (
        <p>
          Open{' '}
          {device.verificationUri &&
          /^https:\/\/(auth\.openai\.com|chatgpt\.com)\//.test(device.verificationUri) ? (
            <a href={device.verificationUri} target="_blank" rel="noreferrer">
              OpenAI device login
            </a>
          ) : (
            'the OpenAI device login page'
          )}{' '}
          and enter <strong>{device.userCode}</strong>.
        </p>
      )}
      {device.message && <p>{device.message}</p>}
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
