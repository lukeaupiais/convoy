import { useEffect, useState, type ReactNode } from 'react';
import {
  command,
  owns,
  type RuntimeState,
  type Session,
  type RuntimeAction,
  type RuntimeCommandInputMap,
} from '../../shared/api/runtime';
import type {
  CapabilityProfile,
  CapabilityState,
  CapabilityTool,
  EffectiveCapabilities,
  ProfileRef,
  SkillRevision,
} from '../../../../../packages/contracts/src';
import { Select } from '../../shared/ui/Select';
import './capabilities.css';
import { ToolLibrary } from './ToolLibrary';

export type {
  CapabilityProfile,
  CapabilityState,
  CapabilityTool,
  EffectiveCapabilities,
  ProfileRef,
  SkillRevision,
};
const key = (p: ProfileRef) => `${p.id}@${p.version}`;
function download(name: string, value: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ProfilePicker({
  state,
  value,
  onChange,
  disabled = false,
  label = 'Capability profile',
  emptyLabel = 'Legacy defaults',
}: {
  state: RuntimeState;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  label?: string;
  emptyLabel?: string;
}) {
  return (
    <Select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{emptyLabel}</option>
      {state.capabilities?.profiles.map((p) => (
        <option key={key(p)} value={key(p)}>
          {p.name} · v{p.version}
        </option>
      ))}
    </Select>
  );
}
export function profileRef(state: RuntimeState, value: string) {
  const p = state.capabilities?.profiles.find((p) => key(p) === value);
  return p ? { id: p.id, version: p.version } : null;
}

export function SessionCapabilities({
  state,
  session: s,
}: {
  state: RuntimeState;
  session: Session;
}) {
  const [value, setValue] = useState(s.capabilityProfile ? key(s.capabilityProfile) : '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(
    () => setValue(s.capabilityProfile ? key(s.capabilityProfile) : ''),
    [s.id, s.capabilityProfile?.id, s.capabilityProfile?.version],
  );
  const locked =
    busy ||
    !owns(s) ||
    ['running', 'queued', 'waiting_approval', 'waiting_question'].includes(s.status) ||
    (!!s.flow && !['completed', 'cancelled'].includes(s.flow.status));
  return (
    <details className="runtime-details capability-session">
      <summary>
        Tools & skills
        {s.capabilityProfile && ` · ${s.capabilityProfile.name} v${s.capabilityProfile.version}`}
      </summary>
      <div className="runtime-toolbar">
        <ProfilePicker state={state} value={value} onChange={setValue} disabled={locked} />
        <button
          className="secondary"
          disabled={locked}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              await command('setCapabilityProfile', {
                sessionId: s.id,
                profile: profileRef(state, value),
              });
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Apply profile
        </button>
      </div>
      {!owns(s) && <p className="muted">Claim session control to change its profile.</p>}
      {error && <p role="alert">{error}</p>}
      <div className="capability-list">
        {s.effectiveCapabilities?.tools.map((t) => (
          <div key={t.id}>
            <span>{t.name}</span>
            <small>
              {t.available ? (t.approval === 'ask' ? 'Approval required' : 'Available') : t.reason}
            </small>
          </div>
        ))}
      </div>
      {!!s.effectiveCapabilities?.skills.length && (
        <div className="capability-list">
          {s.effectiveCapabilities.skills.map((k) => (
            <div key={k.name}>
              <span>
                {k.name} · v{k.version}
              </span>
              <small>{k.active ? 'Loaded' : 'Available on demand'}</small>
            </div>
          ))}
        </div>
      )}
    </details>
  );
}

const example =
  '---\nname: implementation-review\ndescription: Review an implementation against its acceptance criteria.\n---\n\nCheck the requested scope, inspect the changes, and report verification evidence and unresolved risks.\n';
export function CapabilityLibrary({
  state,
  projectId,
  children,
}: {
  state: RuntimeState;
  projectId?: string;
  children: ReactNode;
}) {
  const [tab, setTab] = useState('Tools');
  const [skillEditorOpen, setSkillEditorOpen] = useState(true);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [files, setFiles] = useState<Record<string, string>>({ 'SKILL.md': example });
  const [source, setSource] = useState('UI editor');
  const [preview, setPreview] = useState<{
    name: string;
    hash: string;
    description: string;
    warnings: string[];
    baseVersion: number;
  } | null>(null);
  const [trusted, setTrusted] = useState(false);
  const [profileId, setProfileId] = useState('');
  const [profileName, setProfileName] = useState('');
  const [baseVersion, setBaseVersion] = useState(0);
  const [tools, setTools] = useState<string[]>([]);
  const [skills, setSkills] = useState<string[]>([]);
  const data = state.capabilities;
  if (!data) return <p>Restart the daemon to load the capability library.</p>;
  const latestSkills = [...new Map(data.skills.map((s) => [s.name, s])).values()];
  async function perform<Action extends RuntimeAction>(
    action: Action,
    input: RuntimeCommandInputMap[Action],
  ) {
    setBusy(true);
    setMessage('');
    try {
      const response = await command(action, input);
      return response.result;
    } catch (e) {
      setMessage((e as Error).message);
      throw e;
    } finally {
      setBusy(false);
    }
  }
  const toggle = (values: string[], v: string) =>
    values.includes(v) ? values.filter((x) => x !== v) : [...values, v];
  function editProfile(p?: CapabilityProfile) {
    setProfileId(p?.id ?? '');
    setProfileName(p?.name ?? '');
    setBaseVersion(p?.version ?? 0);
    setTools(p?.tools.map((t) => t.id) ?? []);
    setSkills(p?.skills.map((s) => `${s.name}@${s.version}`) ?? []);
  }
  async function importFiles(list: FileList | null) {
    if (!list?.length) return;
    try {
      if (list.length > 50) throw new Error('Choose at most 50 text files.');
      let entries: Record<string, string> = {};
      let size = 0;
      for (const f of Array.from(list)) {
        size += f.size;
        if (size > 200000) throw new Error('Skill bundles are limited to 200 KB.');
        const relative = f.webkitRelativePath;
        const path = relative ? relative.split('/').slice(1).join('/') : f.name;
        entries[path] = await f.text();
      }
      if (list.length === 1 && list[0].name.endsWith('.json')) {
        const bundle = JSON.parse(await list[0].text());
        entries = bundle.files;
      }
      setFiles(entries);
      setSource(list[0].webkitRelativePath.split('/')[0] || list[0].name);
      setPreview(null);
      setTrusted(false);
      setMessage('Imported for review. Nothing has been published.');
    } catch (e) {
      setMessage((e as Error).message);
    }
  }
  return (
    <section className="capability-library" aria-label="Capability library">
      <nav className="capability-tabs" aria-label="Library sections">
        {['Tools', 'Skills', 'Profiles', 'Instructions'].map((t) => (
          <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </nav>
      {message && <p role="status">{message}</p>}
      {tab === 'Tools' && (
        <>
          <input
            className="capability-search"
            aria-label="Find tools"
            placeholder="Find a tool…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <ToolLibrary
            tools={data.tools}
            disabledTools={data.disabledTools}
            query={query}
            busy={busy}
            approvalRules={state.approvalRules}
            onRemoveRule={(rule) => {
              if (confirm(`Remove saved approval rule “${rule.label}”?`))
                void perform('removeApprovalRule', { ruleId: rule.id }).catch(() => {});
            }}
            onToggle={(t) => {
              if (
                confirm(
                  `${data.disabledTools.includes(t.id) ? 'Enable' : 'Disable'} ${t.name} for all sessions? Pending calls will be rechecked.`,
                )
              )
                void perform('setToolEnabled', {
                  id: t.id,
                  enabled: data.disabledTools.includes(t.id),
                }).catch(() => {});
            }}
          />
        </>
      )}
      {tab === 'Skills' && (
        <>
          <div className="capability-cards">
            {latestSkills.map((s) => (
              <details key={s.name}>
                <summary>
                  <strong>{s.name}</strong>
                  <small>v{s.version}</small>
                </summary>
                <p>{s.description}</p>
                <small>
                  {s.resources.length} files · {s.hash.slice(0, 12)}
                </small>
                <div className="runtime-toolbar">
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      void perform('exportSkill', { name: s.name, version: s.version })
                        .then((bundle) => {
                          setSkillEditorOpen(true);
                          setFiles(bundle.files);
                          setSource(bundle.source);
                          setPreview(null);
                          setTrusted(false);
                        })
                        .catch(() => {})
                    }
                  >
                    Edit next revision
                  </button>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      void perform('exportSkill', { name: s.name, version: s.version })
                        .then((bundle) => download(`${s.name}-v${s.version}.json`, bundle))
                        .catch(() => {})
                    }
                  >
                    Export bundle
                  </button>
                </div>
              </details>
            ))}
          </div>
          <details
            className="capability-editor"
            open={skillEditorOpen}
            onToggle={(e) => setSkillEditorOpen(e.currentTarget.open)}
          >
            <summary>Create or import a skill</summary>
            <div className="runtime-toolbar">
              <label className="secondary">
                Import files
                <input type="file" multiple onChange={(e) => void importFiles(e.target.files)} />
              </label>
              <label className="secondary">
                Import folder
                <input
                  type="file"
                  multiple
                  {...{ webkitdirectory: '' }}
                  onChange={(e) => void importFiles(e.target.files)}
                />
              </label>
            </div>
            <label>
              SKILL.md
              <textarea
                aria-label="Skill source"
                rows={12}
                value={files?.['SKILL.md'] ?? ''}
                onChange={(e) => {
                  setFiles({ ...files, 'SKILL.md': e.target.value });
                  setPreview(null);
                  setTrusted(false);
                }}
              />
            </label>
            <small>
              {Object.keys(files ?? {}).length} bundled files · Text resources only in this release.
              Scripts are not installed or executed.
            </small>
            <div className="runtime-toolbar">
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void perform('validateSkill', { files })
                    .then((p) => {
                      setPreview({
                        ...p,
                        baseVersion:
                          data.skills.filter((s) => s.name === p.name).at(-1)?.version ?? 0,
                      });
                      setMessage(
                        'Valid skill. Review the source and resources before trusting it.',
                      );
                    })
                    .catch(() => {})
                }
              >
                Validate
              </button>
            </div>
            {preview && (
              <>
                <p>
                  {preview.name} · {preview.description}
                </p>
                {preview.warnings.map((w) => (
                  <p key={w}>{w}</p>
                ))}
                <details>
                  <summary>Review bundled resources</summary>
                  {Object.entries(files).map(([path, content]) => (
                    <details key={path}>
                      <summary>{path}</summary>
                      <pre>{content}</pre>
                    </details>
                  ))}
                </details>
                <label className="capability-check">
                  <input
                    type="checkbox"
                    checked={trusted}
                    onChange={(e) => setTrusted(e.target.checked)}
                  />
                  I reviewed and trust these instructions and resources.
                </label>
                <button
                  className="primary"
                  disabled={busy || !trusted}
                  onClick={() =>
                    void perform('publishSkill', {
                      files,
                      source,
                      trusted,
                      baseVersion: preview.baseVersion,
                    })
                      .then(() => {
                        setMessage(
                          'Skill published. Existing profiles keep their pinned revision.',
                        );
                        setPreview(null);
                        setTrusted(false);
                      })
                      .catch(() => {})
                  }
                >
                  Publish revision
                </button>
              </>
            )}
          </details>
        </>
      )}
      {tab === 'Profiles' && (
        <>
          <div className="runtime-toolbar">
            <Select
              aria-label="Edit profile"
              value={profileId && baseVersion ? `${profileId}@${baseVersion}` : ''}
              onChange={(e) => editProfile(data.profiles.find((p) => key(p) === e.target.value))}
            >
              <option value="">New profile</option>
              {data.profiles.map((p) => (
                <option key={key(p)} value={key(p)}>
                  {p.name} · v{p.version}
                </option>
              ))}
            </Select>
            {profileId && baseVersion > 0 && (
              <button
                className="secondary"
                onClick={() =>
                  download(
                    `${profileId}-v${baseVersion}.json`,
                    data.profiles.find((p) => p.id === profileId && p.version === baseVersion),
                  )
                }
              >
                Export profile
              </button>
            )}
          </div>
          <form
            className="capability-editor"
            onSubmit={(e) => {
              e.preventDefault();
              void perform('publishProfile', {
                id: profileId,
                name: profileName,
                baseVersion,
                tools,
                skills: skills.map((v) => {
                  const i = v.lastIndexOf('@');
                  return { name: v.slice(0, i), version: Number(v.slice(i + 1)) };
                }),
              })
                .then((p) => {
                  editProfile(p);
                  setMessage(
                    'Profile published. Apply it to an idle session or use it as a project default.',
                  );
                })
                .catch(() => {});
            }}
          >
            <div className="capability-fields">
              <label>
                Name
                <input
                  required
                  value={profileName}
                  onChange={(e) => setProfileName(e.target.value)}
                />
              </label>
              <label>
                ID
                <input
                  required
                  pattern="[a-z0-9]+(-[a-z0-9]+)*"
                  disabled={baseVersion > 0}
                  value={profileId}
                  onChange={(e) => setProfileId(e.target.value)}
                />
              </label>
            </div>
            <fieldset>
              <legend>Tools</legend>
              <div className="capability-options">
                {data.tools
                  .filter((t) => t.group !== 'harness')
                  .map((t) => (
                    <label key={t.id} className="capability-check">
                      <input
                        type="checkbox"
                        checked={tools.includes(t.id)}
                        onChange={() => setTools(toggle(tools, t.id))}
                      />
                      {t.name}
                    </label>
                  ))}
              </div>
            </fieldset>
            <fieldset>
              <legend>Skills</legend>
              {!data.skills.length && <p>Import a skill to select it here.</p>}
              {[
                ...new Map(
                  [
                    ...latestSkills,
                    ...data.skills.filter((s) => skills.includes(`${s.name}@${s.version}`)),
                  ].map((s) => [`${s.name}@${s.version}`, s]),
                ).values(),
              ].map((s) => (
                <label key={`${s.name}@${s.version}`} className="capability-check">
                  <input
                    type="checkbox"
                    checked={skills.includes(`${s.name}@${s.version}`)}
                    onChange={() => {
                      const k = `${s.name}@${s.version}`;
                      setSkills(
                        skills.includes(k)
                          ? skills.filter((v) => v !== k)
                          : [...skills.filter((v) => !v.startsWith(s.name + '@')), k],
                      );
                    }}
                  />
                  {s.name} · v{s.version}
                </label>
              ))}
            </fieldset>
            <p className="muted">
              Harness controls remain available. Profiles select capabilities; they do not bypass
              approvals, workflow restrictions, or runner limits.
            </p>
            <button className="primary" disabled={busy}>
              Publish profile
            </button>
          </form>
          {projectId && (
            <label className="capability-default">
              Default for {state.projects.find((p) => p.id === projectId)?.name}
              <ProfilePicker
                label="Project capability profile"
                state={state}
                value={data.projectProfiles[projectId] ? key(data.projectProfiles[projectId]!) : ''}
                disabled={busy}
                onChange={(value) =>
                  void perform('setProjectProfile', {
                    projectId,
                    profile: profileRef(state, value),
                    expected: data.projectProfiles[projectId] ?? null,
                  })
                    .then(() =>
                      setMessage(
                        'Default updated for new sessions. Existing sessions are unchanged.',
                      ),
                    )
                    .catch(() => {})
                }
              />
            </label>
          )}
        </>
      )}
      {tab === 'Instructions' && children}
    </section>
  );
}
