import { useEffect, useState } from 'react';
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
  SkillSelection,
} from '../../../../../packages/contracts/src';
import { Select } from '../../shared/ui/Select';
import './capabilities.css';
import { KnowledgePicker } from '../knowledge';
import type { KnowledgeSelection } from '../../../../../packages/contracts/src';
import { toolDescription } from './ToolLibrary';
import { SkillSettings } from './SkillSettings';
import { ProfileSkillSources } from './ProfileSkillSources';

export type {
  CapabilityProfile,
  CapabilityState,
  CapabilityTool,
  EffectiveCapabilities,
  ProfileRef,
  SkillRevision,
  SkillSelection,
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
  acquireControl,
  onManageAgents,
}: {
  state: RuntimeState;
  session: Session;
  acquireControl?: () => Promise<void>;
  onManageAgents?: () => void;
}) {
  const [value, setValue] = useState(s.capabilityProfile ? key(s.capabilityProfile) : '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(
    () => setValue(s.capabilityProfile ? key(s.capabilityProfile) : ''),
    [s.id, s.capabilityProfile?.id, s.capabilityProfile?.version],
  );
  const canControl = owns(s) || !!acquireControl;
  const locked =
    busy ||
    !canControl ||
    ['running', 'queued', 'waiting_approval', 'waiting_question'].includes(s.status) ||
    (!!s.flow && !['completed', 'cancelled'].includes(s.flow.status));
  return (
    <details className="runtime-details capability-session">
      <summary>
        Tools & skills
        {s.capabilityProfile && ` · ${s.capabilityProfile.name} v${s.capabilityProfile.version}`}
      </summary>
      <div className="runtime-toolbar">
        {onManageAgents && (
          <button type="button" className="secondary" onClick={onManageAgents}>
            Manage profiles
          </button>
        )}
        <ProfilePicker state={state} value={value} onChange={setValue} disabled={locked} />
        <button
          className="secondary"
          disabled={locked}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              await acquireControl?.();
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
      {!canControl && <p className="muted">Claim session control to change its profile.</p>}
      {error && <p role="alert">{error}</p>}
      <details>
        <summary>
          Workspace guidance ·{' '}
          {s.workspaceGuidance?.status ??
            (s.capabilityProfile?.loadWorkspaceAgentsMd ? 'pending' : 'disabled')}
        </summary>
        {s.workspaceGuidance?.hash && (
          <p>
            <code>{s.workspaceGuidance.hash}</code>
          </p>
        )}
        {s.workspaceGuidance?.source && (
          <p>
            {s.workspaceGuidance.source.kind}
            {s.workspaceGuidance.source.repository && ` · ${s.workspaceGuidance.source.repository}`}
          </p>
        )}
        {s.workspaceGuidance?.error && <p role="alert">{s.workspaceGuidance.error}</p>}
        {s.workspaceGuidance?.status === 'missing' && (
          <p>
            AGENTS.md is absent in this workspace. Add it through authorized workspace setup, or
            create a new workspace with local guidance enabled.
          </p>
        )}
        <button
          className="secondary"
          disabled={
            busy ||
            !canControl ||
            !!s.control?.busy ||
            !s.workspace ||
            !s.capabilityProfile?.loadWorkspaceAgentsMd ||
            s.assignment?.state === 'uncertain'
          }
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              await acquireControl?.();
              await command('refreshWorkspaceGuidance', {
                sessionId: s.id,
                captureId: s.workspaceGuidance?.id ?? null,
              });
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Refresh
        </button>
      </details>
      <p>Execution · {s.executionGrant?.profileId ?? s.executionProfile ?? 'inherit'}</p>
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
            <div key={k.snapshotId ?? k.name}>
              <span>
                {k.name}
                {k.sourceId ? ' · Captured source' : ` · v${k.version}`}
              </span>
              <small>{k.active ? 'Loaded' : 'Available on demand'}</small>
              {k.sourceId &&
                state.capabilities?.skillCatalogue?.sources
                  .find((source) => source.id === k.sourceId)
                  ?.instances.some(
                    (instance) =>
                      instance.runnerId === k.runnerId &&
                      instance.workspaceId === k.workspaceId &&
                      instance.digest &&
                      instance.digest !== k.hash,
                  ) && (
                  <small role="status">
                    Source changed · This session keeps its captured files
                  </small>
                )}
            </div>
          ))}
        </div>
      )}
    </details>
  );
}

export function canLeaveAgents() {
  return window.dispatchEvent(new Event('convoy-agents-leave', { cancelable: true }));
}

export function AgentSettings({ state }: { state: RuntimeState }) {
  const [tab, setTab] = useState('Profiles');
  const [profileEditorOpen, setProfileEditorOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [profileId, setProfileId] = useState('');
  const [profileName, setProfileName] = useState('');
  const [loadWorkspaceAgentsMd, setLoadWorkspaceAgentsMd] = useState(false);
  const [knowledge, setKnowledge] = useState<KnowledgeSelection>({ collectionIds: [] });
  const [baseVersion, setBaseVersion] = useState(0);
  const [tools, setTools] = useState<string[]>([]);
  const [skills, setSkills] = useState<string[]>([]);
  const [skillSelections, setSkillSelections] = useState<SkillSelection[]>([]);
  const [initialProfile, setInitialProfile] = useState('');
  const [customId, setCustomId] = useState(false);
  const [toolQuery, setToolQuery] = useState('');
  const [browsing, setBrowsing] = useState({ tools: false, skills: false, extensions: false });
  const [extensions, setExtensions] = useState<CapabilityProfile['extensions']>([]);
  useEffect(() => {
    setProfileEditorOpen(false);
    setSkills([]);
    setSkillSelections([]);
    setMessage('');
  }, [state.activeContext?.organizationId, state.currentUser?.id, state.activeContext?.projectId]);
  const profileDraft = JSON.stringify({
    profileId,
    profileName,
    loadWorkspaceAgentsMd,
    knowledge,
    tools,
    skills,
    skillSelections,
    extensions,
  });
  const profileDirty = profileDraft !== initialProfile;
  const unsavedDraft = profileEditorOpen && profileDirty;
  useEffect(() => {
    if (!unsavedDraft && !busy) return;
    const leave = (event: Event) => {
      if (busy || !confirm('Discard unsaved agent changes?')) event.preventDefault();
    };
    const unload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('convoy-agents-leave', leave);
    window.addEventListener('beforeunload', unload);
    return () => {
      window.removeEventListener('convoy-agents-leave', leave);
      window.removeEventListener('beforeunload', unload);
    };
  }, [unsavedDraft, busy]);
  const data = state.capabilities;
  if (!data) return <p>Restart the daemon to load the capability library.</p>;
  const latestSkills = [
    ...new Map(
      [...data.skills].sort((a, b) => a.version - b.version).map((s) => [s.name, s]),
    ).values(),
  ];
  const latestProfiles = [
    ...new Map(
      [...data.profiles].sort((a, b) => a.version - b.version).map((p) => [p.id, p]),
    ).values(),
  ];
  function cancelProfile() {
    if (!profileDirty || confirm('Discard unsaved profile changes?')) {
      setProfileEditorOpen(false);
      setMessage('');
    }
  }
  const matches = (...values: (string | undefined)[]) =>
    values.join(' ').toLowerCase().includes(query.toLowerCase());
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
    setMessage('');
    setCustomId(false);
    setToolQuery('');
    setBrowsing({ tools: false, skills: false, extensions: false });
    setInitialProfile(
      JSON.stringify({
        profileId: p?.id ?? '',
        profileName: p?.name ?? '',
        loadWorkspaceAgentsMd: p?.loadWorkspaceAgentsMd === true,
        knowledge: p?.knowledge ?? { collectionIds: [] },
        tools: p?.tools.map((t) => t.id) ?? [],
        skills: p?.skills.map((s) => `${s.name}@${s.version}`) ?? [],
        skillSelections: p?.skillSelections ?? [],
        extensions: p?.extensions ?? [],
      }),
    );
    setProfileEditorOpen(true);
    setProfileId(p?.id ?? '');
    setProfileName(p?.name ?? '');
    setLoadWorkspaceAgentsMd(p?.loadWorkspaceAgentsMd === true);
    setKnowledge(p?.knowledge ?? { collectionIds: [] });
    setBaseVersion(p?.version ?? 0);
    setTools(p?.tools.map((t) => t.id) ?? []);
    setSkills(p?.skills.map((s) => `${s.name}@${s.version}`) ?? []);
    setSkillSelections(p?.skillSelections ?? []);
    setExtensions(p?.extensions ?? []);
  }

  return (
    <section className="capability-library" aria-label="Agent configuration">
      <nav className="capability-tabs" aria-label="Agent sections">
        {['Profiles', 'Skills'].map((t) => (
          <button
            key={t}
            aria-pressed={tab === t}
            disabled={busy}
            onClick={() => {
              if (tab === t || !canLeaveAgents()) return;
              setProfileEditorOpen(false);
              setTab(t);
              setQuery('');
              setMessage('');
            }}
          >
            {t}
          </button>
        ))}
      </nav>
      {message && <p role="status">{message}</p>}
      {tab === 'Skills' && <SkillSettings state={state} />}
      {tab === 'Profiles' && (
        <div className="library-toolbar" hidden={profileEditorOpen}>
          <input
            className="capability-search"
            aria-label="Find profiles"
            placeholder="Find profiles…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button className="primary" onClick={() => editProfile()}>
            New profile
          </button>
        </div>
      )}
      {tab === 'Profiles' && (
        <>
          <div className="capability-cards" hidden={profileEditorOpen}>
            {latestProfiles
              .filter((p) => matches(p.name, p.id))
              .map((p) => (
                <article className="profile-row" key={p.id}>
                  <button type="button" className="profile-row-open" onClick={() => editProfile(p)}>
                    <strong>{p.name}</strong>
                    <span className="library-description">
                      {p.tools.length} tools · {p.skills.length + (p.skillSelections?.length ?? 0)}{' '}
                      skills
                      {p.extensions.length > 0 && ` · ${p.extensions.length} extensions`}
                    </span>
                  </button>
                  <details className="profile-row-menu">
                    <summary aria-label={`Actions for ${p.name}`}>•••</summary>
                    <div>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => download(`${p.id}-v${p.version}.json`, p)}
                      >
                        Export
                      </button>
                      {data.profiles.some(
                        (value) => value.id === p.id && value.version !== p.version,
                      ) && (
                        <details>
                          <summary>Revision history</summary>
                          {data.profiles
                            .filter((value) => value.id === p.id && value.version !== p.version)
                            .map((value) => (
                              <button
                                type="button"
                                className="secondary"
                                key={key(value)}
                                onClick={() => editProfile(value)}
                              >
                                Revision {value.version}
                              </button>
                            ))}
                        </details>
                      )}
                    </div>
                  </details>
                </article>
              ))}
            {!latestProfiles.some((p) => matches(p.name, p.id)) && (
              <p>{query ? 'No matching profiles.' : 'No profiles yet.'}</p>
            )}
          </div>
          {state.approvalRules.length > 0 && !profileEditorOpen && (
            <details className="agent-approval-rules">
              <summary>Saved approval rules · {state.approvalRules.length}</summary>
              <p>These rules apply across profiles within their saved scope.</p>
              {state.approvalRules.map((rule) => (
                <div key={rule.id}>
                  <span>
                    {rule.label} · {rule.tool} · {rule.scope.kind}
                  </span>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      if (confirm(`Remove saved approval rule “${rule.label}”?`))
                        void perform('removeApprovalRule', { ruleId: rule.id }).catch(() => {});
                    }}
                  >
                    Remove rule
                  </button>
                </div>
              ))}
            </details>
          )}
          {profileEditorOpen && (
            <form
              onInvalid={(event) => {
                const target = event.target as HTMLElement;
                target.closest('details')?.setAttribute('open', '');
              }}
              className="capability-editor"
              onSubmit={(e) => {
                e.preventDefault();
                void perform('publishProfile', {
                  id: profileId,
                  name: profileName,
                  loadWorkspaceAgentsMd,
                  knowledge,
                  baseVersion,
                  tools,
                  extensions,
                  skillSelections,
                  skills: skills.map((v) => {
                    const i = v.lastIndexOf('@');
                    return { name: v.slice(0, i), version: Number(v.slice(i + 1)) };
                  }),
                })
                  .then(() => {
                    setProfileEditorOpen(false);
                    setMessage(
                      'Profile saved. Existing sessions and project defaults keep their selected revision.',
                    );
                  })
                  .catch(() => {});
              }}
            >
              <header className="library-editor-heading">
                <strong>{baseVersion ? profileName : 'New profile'}</strong>
                <span className="profile-draft-status" role="status">
                  {profileDirty ? 'Unsaved changes' : ''}
                </span>
              </header>
              <label>
                Name
                <input
                  required
                  value={profileName}
                  onChange={(e) => {
                    setProfileName(e.target.value);
                    if (!baseVersion && !customId)
                      setProfileId(
                        e.target.value
                          .toLowerCase()
                          .normalize('NFKD')
                          .replace(/[\u0300-\u036f]/g, '')
                          .replace(/[^a-z0-9]+/g, '-')
                          .replace(/^-|-$/g, ''),
                      );
                  }}
                />
              </label>
              <details className="profile-section">
                <summary>
                  Tools <span>{tools.length} selected</span>
                </summary>
                {browsing.tools && data.tools.filter((t) => t.group !== 'harness').length > 8 && (
                  <input
                    aria-label="Find tools"
                    placeholder="Find tools…"
                    value={toolQuery}
                    onChange={(e) => setToolQuery(e.target.value)}
                  />
                )}
                <div>
                  <div className="capability-section-actions">
                    <button
                      type="button"
                      className="secondary"
                      aria-label={browsing.tools ? 'Done adding tools' : 'Add tools'}
                      aria-expanded={browsing.tools}
                      onClick={() => {
                        setBrowsing((current) => ({ ...current, tools: !current.tools }));
                        setToolQuery('');
                      }}
                    >
                      {browsing.tools ? 'Done' : 'Add'}
                    </button>
                  </div>
                  {!tools.length && !browsing.tools && <p className="muted">No tools selected.</p>}
                  <div className="capability-options">
                    {data.tools
                      .filter(
                        (t) =>
                          t.group !== 'harness' &&
                          (browsing.tools || tools.includes(t.id)) &&
                          `${toolDescription(t).title} ${t.name}`
                            .toLowerCase()
                            .includes(toolQuery.toLowerCase()),
                      )
                      .sort((a, b) => Number(tools.includes(b.id)) - Number(tools.includes(a.id)))
                      .map((t) => (
                        <div key={t.id}>
                          <label className="capability-check">
                            <input
                              type="checkbox"
                              checked={tools.includes(t.id)}
                              onChange={() => setTools(toggle(tools, t.id))}
                            />
                            {toolDescription(t).title}
                          </label>
                          <details className="profile-tool-details">
                            <summary>Details</summary>
                            <p>{toolDescription(t).brief}</p>
                            <p>
                              {t.approval === 'ask'
                                ? 'Requires approval unless a saved rule applies.'
                                : 'Approval not required.'}
                            </p>
                            {data.disabledTools.includes(t.id) && (
                              <p>Disabled by the deployment.</p>
                            )}
                          </details>
                        </div>
                      ))}
                    {tools
                      .filter(
                        (id) =>
                          !data.tools.some((tool) => tool.id === id && tool.group !== 'harness'),
                      )
                      .map((id) => (
                        <label className="capability-check" key={id}>
                          <input
                            type="checkbox"
                            checked
                            onChange={() =>
                              setTools((current) => current.filter((value) => value !== id))
                            }
                          />
                          {id} · Unavailable
                        </label>
                      ))}
                  </div>
                </div>
              </details>
              <details className="profile-section">
                <summary>
                  Extensions <span>{extensions.length} selected</span>
                </summary>
                <div>
                  {data.extensions.length > 0 && (
                    <div className="capability-section-actions">
                      <button
                        type="button"
                        className="secondary"
                        aria-label={
                          browsing.extensions ? 'Done adding extensions' : 'Add extensions'
                        }
                        aria-expanded={browsing.extensions}
                        onClick={() =>
                          setBrowsing((current) => ({
                            ...current,
                            extensions: !current.extensions,
                          }))
                        }
                      >
                        {browsing.extensions ? 'Done' : 'Add'}
                      </button>
                    </div>
                  )}
                  {!extensions.length && data.extensions.length > 0 && !browsing.extensions && (
                    <p className="muted">No extensions selected.</p>
                  )}
                  {!data.extensions.length && (
                    <p>No extensions registered. Manage registrations in Integrations.</p>
                  )}
                  {[...new Set(data.extensions.map((extension) => extension.id))]
                    .filter((id) => browsing.extensions || extensions.some((pin) => pin.id === id))
                    .sort(
                      (a, b) =>
                        Number(extensions.some((pin) => pin.id === b)) -
                        Number(extensions.some((pin) => pin.id === a)),
                    )
                    .map((id) => {
                      const revisions = data.extensions.filter((extension) => extension.id === id);
                      const pin = extensions.find((value) => value.id === id);
                      const chosen = revisions.find(
                        (extension) =>
                          extension.revision === pin?.revision && extension.hash === pin.hash,
                      );
                      const fallback = revisions.at(-1)!;
                      return (
                        <div className="profile-choice" key={id}>
                          <label className="capability-check">
                            <input
                              type="checkbox"
                              checked={!!pin}
                              onChange={(event) =>
                                setExtensions((current) =>
                                  event.target.checked
                                    ? [
                                        ...current.filter((value) => value.id !== id),
                                        { id, revision: fallback.revision, hash: fallback.hash },
                                      ]
                                    : current.filter((value) => value.id !== id),
                                )
                              }
                            />
                            {id}
                          </label>
                          <details>
                            <summary>Revision{pin ? ` · ${pin.revision}` : ''}</summary>
                            <select
                              aria-label={`Revision for ${id}`}
                              disabled={!pin}
                              value={chosen ? `${chosen.revision}@${chosen.hash}` : ''}
                              onChange={(event) => {
                                const revision = revisions.find(
                                  (value) =>
                                    `${value.revision}@${value.hash}` === event.target.value,
                                );
                                if (revision)
                                  setExtensions((current) => [
                                    ...current.filter((value) => value.id !== id),
                                    { id, revision: revision.revision, hash: revision.hash },
                                  ]);
                              }}
                            >
                              {!chosen && (
                                <option value="">
                                  {pin
                                    ? `Unavailable revision ${pin.revision}`
                                    : 'Select a revision'}
                                </option>
                              )}
                              {revisions.map((revision) => (
                                <option
                                  key={`${revision.revision}@${revision.hash}`}
                                  value={`${revision.revision}@${revision.hash}`}
                                >
                                  {revision.revision}
                                </option>
                              ))}
                            </select>
                          </details>
                        </div>
                      );
                    })}
                  {extensions
                    .filter((pin) => !data.extensions.some((extension) => extension.id === pin.id))
                    .map((pin) => (
                      <label className="capability-check" key={`${pin.id}@${pin.revision}`}>
                        <input
                          type="checkbox"
                          checked
                          onChange={() =>
                            setExtensions((current) => current.filter((value) => value !== pin))
                          }
                        />
                        {pin.id} · Unavailable revision {pin.revision}
                      </label>
                    ))}
                </div>
              </details>
              <details className="profile-section">
                <summary>
                  Skills <span>{skills.length + skillSelections.length} selected</span>
                </summary>
                <div>
                  {
                    <div className="capability-section-actions">
                      <button
                        type="button"
                        className="secondary"
                        aria-label={browsing.skills ? 'Done adding skills' : 'Add skills'}
                        aria-expanded={browsing.skills}
                        onClick={() =>
                          setBrowsing((current) => ({ ...current, skills: !current.skills }))
                        }
                      >
                        {browsing.skills ? 'Done' : 'Add'}
                      </button>
                    </div>
                  }
                  {!skills.length &&
                    !skillSelections.length &&
                    data.skills.length > 0 &&
                    !browsing.skills && <p className="muted">No skills selected.</p>}
                  <ProfileSkillSources
                    state={state}
                    selections={skillSelections}
                    onChange={setSkillSelections}
                    browsing={browsing.skills}
                    disabled={busy}
                  />
                  {latestSkills
                    .filter(
                      (skill) =>
                        browsing.skills ||
                        skills.some(
                          (value) => value.slice(0, value.lastIndexOf('@')) === skill.name,
                        ),
                    )
                    .sort(
                      (a, b) =>
                        Number(
                          skills.some((value) => value.slice(0, value.lastIndexOf('@')) === b.name),
                        ) -
                        Number(
                          skills.some((value) => value.slice(0, value.lastIndexOf('@')) === a.name),
                        ),
                    )
                    .map((latest) => {
                      const selectedKey = skills.find(
                        (value) => value.slice(0, value.lastIndexOf('@')) === latest.name,
                      );
                      const revisions = data.skills.filter((value) => value.name === latest.name);
                      return (
                        <div className="profile-choice" key={latest.name}>
                          <label className="capability-check">
                            <input
                              type="checkbox"
                              checked={!!selectedKey}
                              onChange={(event) =>
                                setSkills((current) =>
                                  event.target.checked
                                    ? [...current, `${latest.name}@${latest.version}`]
                                    : current.filter((value) => value !== selectedKey),
                                )
                              }
                            />
                            {latest.name}
                          </label>
                          <details>
                            <summary>
                              Revision
                              {selectedKey
                                ? ` · ${selectedKey.slice(selectedKey.lastIndexOf('@') + 1)}`
                                : ''}
                            </summary>
                            <select
                              aria-label={`Revision for ${latest.name}`}
                              disabled={!selectedKey}
                              value={selectedKey ?? `${latest.name}@${latest.version}`}
                              onChange={(event) =>
                                setSkills((current) => [
                                  ...current.filter((value) => value !== selectedKey),
                                  event.target.value,
                                ])
                              }
                            >
                              {selectedKey &&
                                !revisions.some(
                                  (value) => `${value.name}@${value.version}` === selectedKey,
                                ) && <option value={selectedKey}>Unavailable revision</option>}
                              {revisions.map((value) => (
                                <option
                                  key={value.version}
                                  value={`${value.name}@${value.version}`}
                                >
                                  {value.version}
                                </option>
                              ))}
                            </select>
                          </details>
                        </div>
                      );
                    })}
                  {skills
                    .filter(
                      (value) =>
                        !latestSkills.some(
                          (skill) => value.slice(0, value.lastIndexOf('@')) === skill.name,
                        ),
                    )
                    .map((value) => (
                      <label className="capability-check" key={value}>
                        <input
                          type="checkbox"
                          checked
                          onChange={() =>
                            setSkills((current) => current.filter((item) => item !== value))
                          }
                        />
                        {value} · Unavailable
                      </label>
                    ))}
                </div>
              </details>
              <details className="profile-section">
                <summary>Advanced</summary>
                <div>
                  <label>
                    ID
                    <input
                      required
                      pattern="[a-z0-9]+(-[a-z0-9]+)*"
                      disabled={baseVersion > 0}
                      value={profileId}
                      onChange={(e) => {
                        setCustomId(true);
                        setProfileId(e.target.value);
                      }}
                    />
                  </label>
                  <label className="capability-check">
                    <input
                      type="checkbox"
                      checked={loadWorkspaceAgentsMd}
                      onChange={(e) => setLoadWorkspaceAgentsMd(e.target.checked)}
                    />
                    Load workspace AGENTS.md
                  </label>
                  <KnowledgePicker state={state} value={knowledge} onChange={setKnowledge} />
                </div>
              </details>
              <footer className="profile-save-bar">
                <button
                  className="primary"
                  disabled={busy || !profileDirty || !profileId || !profileName.trim()}
                >
                  Save profile
                </button>
                <button type="button" className="secondary" disabled={busy} onClick={cancelProfile}>
                  Cancel
                </button>
              </footer>
            </form>
          )}
        </>
      )}
    </section>
  );
}
