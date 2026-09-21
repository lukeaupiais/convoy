import { createHash, randomUUID as systemRandomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, win32 } from 'node:path';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const PROFILE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;

export function defaultProfilesFile(env = process.env) {
  const root =
    env.CONVOY_CONFIG_HOME ||
    (env.XDG_CONFIG_HOME
      ? join(env.XDG_CONFIG_HOME, 'convoy')
      : join(homedir(), '.config', 'convoy'));
  return join(root, 'client-profiles.json');
}

export function normalizeDeploymentOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Deployment URL must be an absolute HTTP(S) origin.');
  }
  if (url.username || url.password) throw new Error('Deployment URL must not contain credentials.');
  if (url.pathname !== '/' || url.search || url.hash)
    throw new Error('Deployment URL must be an origin without a path, query, or fragment.');
  const loopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    throw new Error(
      'Remote Convoy deployments require HTTPS; plain HTTP is allowed only on loopback.',
    );
  return url.origin;
}

export class MemoryCredentialStore {
  #values = new Map();

  async get(reference) {
    return this.#values.get(reference);
  }

  async set(reference, value) {
    this.#values.set(reference, structuredClone(value));
  }

  async delete(reference) {
    this.#values.delete(reference);
  }
}

function runCredentialProcess({ command, args, input, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'ignore'],
      env,
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.on('error', reject);
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') reject(error);
    });
    child.on('close', (code) => resolve({ code, output }));
    child.stdin.end(input);
  });
}

const MACOS_KEYCHAIN_SERVICE = 'io.convoy.client';

// Windows has no built-in Credential Manager command that can retrieve a generic
// credential. Protect a device-local blob with DPAPI CurrentUser and lock both the
// directory and file to the current user's SID instead of pretending cmdkey is a store.
const WINDOWS_DPAPI_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$action = $env:CONVOY_CREDENTIAL_OPERATION
$path = $env:CONVOY_CREDENTIAL_PATH
$entropy = [Text.Encoding]::UTF8.GetBytes('io.convoy.client.dpapi.v1')
function Lock-ForCurrentUser([string] $target, [bool] $directory) {
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl = New-Object Security.AccessControl.DirectorySecurity
  if (-not $directory) { $acl = New-Object Security.AccessControl.FileSecurity }
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  $inheritance = [Security.AccessControl.InheritanceFlags]::None
  if ($directory) {
    $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  }
  $rule = New-Object Security.AccessControl.FileSystemAccessRule(
    $sid,
    [Security.AccessControl.FileSystemRights]::FullControl,
    $inheritance,
    [Security.AccessControl.PropagationFlags]::None,
    [Security.AccessControl.AccessControlType]::Allow
  )
  [void] $acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $target -AclObject $acl
}
if ($action -eq 'set') {
  $directory = [IO.Path]::GetDirectoryName($path)
  [void] [IO.Directory]::CreateDirectory($directory)
  Lock-ForCurrentUser $directory $true
  $plain = [Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd())
  $cipher = [Security.Cryptography.ProtectedData]::Protect(
    $plain,
    $entropy,
    [Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  $temporary = "$path.$PID.tmp"
  [IO.File]::WriteAllBytes($temporary, $cipher)
  Lock-ForCurrentUser $temporary $false
  if ([IO.File]::Exists($path)) {
    [IO.File]::Replace($temporary, $path, $null)
  } else {
    [IO.File]::Move($temporary, $path)
  }
  Lock-ForCurrentUser $path $false
  exit 0
}
if ($action -eq 'get') {
  if (-not [IO.File]::Exists($path)) { exit 44 }
  $cipher = [IO.File]::ReadAllBytes($path)
  $plain = [Security.Cryptography.ProtectedData]::Unprotect(
    $cipher,
    $entropy,
    [Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  [Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))
  exit 0
}
if ($action -eq 'delete') {
  if ([IO.File]::Exists($path)) { [IO.File]::Delete($path) }
  exit 0
}
throw 'Unknown Convoy credential operation.'
`;

/** Convoy login credentials belong in the native OS credential store, never in profiles. */
export function createSystemCredentialStore({
  env = process.env,
  platform = process.platform,
  run = runCredentialProcess,
  credentialDirectory = defaultCredentialDirectory(platform, env),
} = {}) {
  if (!['linux', 'darwin', 'win32'].includes(platform))
    throw new Error(`Convoy has no supported OS credential store for ${platform}.`);

  const execute = async (request, operation) => {
    try {
      return await run(request);
    } catch (error) {
      if (error?.code === 'ENOENT')
        throw new Error(`The ${credentialStoreName(platform)} OS keychain is unavailable.`);
      throw new Error(
        `Could not ${operation} the Convoy credential in the OS keychain: ${error.message}`,
      );
    }
  };

  return {
    async get(reference) {
      if (env.CONVOY_TOKEN || env.CONVOY_DEVICE_CREDENTIAL) {
        return {
          ...(env.CONVOY_TOKEN ? { accessToken: env.CONVOY_TOKEN } : {}),
          ...(env.CONVOY_DEVICE_CREDENTIAL
            ? { deviceCredential: env.CONVOY_DEVICE_CREDENTIAL }
            : {}),
        };
      }
      const result = await execute(
        credentialRequest(platform, 'get', reference, undefined, env, credentialDirectory),
        'read',
      );
      if (isMissingCredential(platform, result.code) || !result.output.trim()) return undefined;
      if (result.code !== 0)
        throw new Error(
          `Could not read the Convoy credential from the OS keychain (exit ${result.code}).`,
        );
      try {
        const serialized =
          platform === 'darwin'
            ? Buffer.from(result.output.trim(), 'base64').toString('utf8')
            : result.output.trim();
        return credential(JSON.parse(serialized));
      } catch {
        throw new Error('The Convoy credential in the OS keychain is invalid.');
      }
    },
    async set(reference, value) {
      const serialized = JSON.stringify(credential(value));
      const result = await execute(
        credentialRequest(platform, 'set', reference, serialized, env, credentialDirectory),
        'store',
      );
      if (result.code !== 0)
        throw new Error(
          `Could not store the Convoy credential in the OS keychain (exit ${result.code}).`,
        );
    },
    async delete(reference) {
      const result = await execute(
        credentialRequest(platform, 'delete', reference, undefined, env, credentialDirectory),
        'remove',
      );
      if (!isMissingCredential(platform, result.code) && result.code !== 0)
        throw new Error('Could not remove the Convoy credential from the OS keychain.');
    },
  };
}

function credentialRequest(platform, action, reference, value, env, credentialDirectory) {
  if (platform === 'linux') {
    const argsByAction = {
      get: ['lookup', 'application', 'convoy', 'reference', reference],
      set: [
        'store',
        '--label=Convoy client session',
        'application',
        'convoy',
        'reference',
        reference,
      ],
      delete: ['clear', 'application', 'convoy', 'reference', reference],
    };
    return {
      command: 'secret-tool',
      args: argsByAction[action],
      input: action === 'set' ? value : undefined,
      env: {
        PATH: env.PATH,
        ...(env.DBUS_SESSION_BUS_ADDRESS
          ? { DBUS_SESSION_BUS_ADDRESS: env.DBUS_SESSION_BUS_ADDRESS }
          : {}),
      },
    };
  }

  const referenceDigest = createHash('sha256').update(reference).digest('hex');
  if (platform === 'darwin') {
    if (action === 'set') {
      const encoded = Buffer.from(value, 'utf8').toString('base64');
      return {
        command: '/usr/bin/security',
        args: ['-q', '-i'],
        input: `add-generic-password -U -a ${referenceDigest} -s ${MACOS_KEYCHAIN_SERVICE} -w ${encoded}\n`,
        env: { PATH: env.PATH },
      };
    }
    return {
      command: '/usr/bin/security',
      args: [
        action === 'get' ? 'find-generic-password' : 'delete-generic-password',
        '-a',
        referenceDigest,
        '-s',
        MACOS_KEYCHAIN_SERVICE,
        ...(action === 'get' ? ['-w'] : []),
      ],
      env: { PATH: env.PATH },
    };
  }

  const powershell = win32.join(
    env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  return {
    command: powershell,
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_DPAPI_SCRIPT],
    input: action === 'set' ? value : undefined,
    env: {
      SystemRoot: env.SystemRoot || env.SYSTEMROOT,
      ...(env.PATH ? { PATH: env.PATH } : {}),
      CONVOY_CREDENTIAL_OPERATION: action,
      CONVOY_CREDENTIAL_PATH: win32.join(credentialDirectory, `${referenceDigest}.bin`),
    },
  };
}

function isMissingCredential(platform, code) {
  return (
    (platform === 'linux' && code === 1) ||
    (platform === 'darwin' && code === 44) ||
    (platform === 'win32' && code === 44)
  );
}

function credentialStoreName(platform) {
  if (platform === 'linux') return 'Secret Service';
  if (platform === 'darwin') return 'macOS Keychain';
  return 'Windows DPAPI';
}

function defaultCredentialDirectory(platform, env) {
  if (platform !== 'win32') return undefined;
  return win32.join(
    env.LOCALAPPDATA || win32.join(homedir(), 'AppData', 'Local'),
    'Convoy',
    'credentials',
  );
}

export function createClientProfiles({
  file = defaultProfilesFile(),
  credentials = createSystemCredentialStore(),
  fetch: fetchImpl = globalThis.fetch,
  randomUUID = systemRandomUUID,
} = {}) {
  if (typeof fetchImpl !== 'function')
    throw new Error('Client profiles require a fetch implementation.');

  async function load() {
    let parsed;
    try {
      parsed = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, profiles: [] };
      if (error instanceof SyntaxError)
        throw new Error('Convoy client profile file contains invalid JSON.');
      throw error;
    }
    if (parsed?.version !== 1 || !Array.isArray(parsed.profiles))
      throw new Error('Convoy client profile file has an unsupported format.');
    return parsed;
  }

  async function save(state) {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporary, file);
    await chmod(file, 0o600);
  }

  async function connect(value, { name } = {}) {
    const serverOrigin = normalizeDeploymentOrigin(value);
    const response = await fetchImpl(`${serverOrigin}/.well-known/convoy`, {
      headers: { Accept: 'application/json', 'X-Convoy-Client': 'discovery' },
      redirect: 'manual',
    });
    if (response.status >= 300 && response.status < 400)
      throw new Error(
        'Deployment discovery redirects are not followed; connect to the canonical origin.',
      );
    if (!response.ok) throw new Error(`Deployment discovery failed (${response.status}).`);
    const valueFromServer = await response.json();
    const deploymentId = requiredText(
      valueFromServer.deploymentId ?? valueFromServer.id,
      'deployment id',
    );
    const issuer = normalizeDeploymentOrigin(
      requiredText(valueFromServer.issuer, 'deployment issuer'),
    );
    const publicOrigin = normalizeDeploymentOrigin(
      requiredText(valueFromServer.publicOrigin ?? issuer, 'deployment public origin'),
    );
    if (issuer !== serverOrigin || publicOrigin !== serverOrigin)
      throw new Error(
        'Deployment discovery issuer and public origin must match the connected origin.',
      );
    const displayName = requiredText(valueFromServer.displayName, 'deployment display name');
    if (
      !Array.isArray(valueFromServer.authenticationMethods) ||
      !Array.isArray(valueFromServer.capabilities)
    )
      throw new Error('Deployment discovery is missing authentication methods or capabilities.');
    const state = await load();
    const existingAtOrigin = state.profiles.find(
      (profile) => profile.serverOrigin === serverOrigin,
    );
    if (existingAtOrigin && existingAtOrigin.deploymentId !== deploymentId)
      throw new Error(
        'Saved deployment identity changed; explicit profile removal and reconnection are required.',
      );
    const existingDeployment = state.profiles.find(
      (profile) => profile.deploymentId === deploymentId,
    );
    if (existingDeployment && existingDeployment.serverOrigin !== serverOrigin)
      throw new Error('Saved deployment origin changed; explicit identity migration is required.');
    const profileName =
      name ?? existingAtOrigin?.name ?? uniqueName(slug(displayName), state.profiles);
    if (!PROFILE_NAME.test(profileName))
      throw new Error(
        'Profile name must contain only letters, numbers, dots, underscores, or hyphens.',
      );
    const existingName = state.profiles.find((profile) => profile.name === profileName);
    if (existingName && existingName.deploymentId !== deploymentId)
      throw new Error(`Client profile "${profileName}" already names another deployment.`);
    const old = existingAtOrigin ?? existingDeployment ?? existingName;
    const deviceId = old?.deviceId ?? randomUUID();
    const profile = {
      name: profileName,
      deploymentId,
      serverOrigin,
      displayName,
      trustedServerIdentity: `${deploymentId}@${issuer}`,
      deviceId,
      secureCredentialReference:
        old?.secureCredentialReference ?? `convoy:${deploymentId}:${deviceId}`,
      ...(old?.lastContext ? { lastContext: old.lastContext } : {}),
    };
    state.profiles = state.profiles.filter((candidate) => candidate !== old);
    state.profiles.push(profile);
    state.current = profile.name;
    await save(state);
    return profile;
  }

  return {
    connect,
    async list() {
      const state = await load();
      return state.profiles.map((profile) => ({
        ...profile,
        current: state.current === profile.name,
      }));
    },
    async current(name) {
      const state = await load();
      const selected = name ?? state.current;
      return state.profiles.find((profile) => profile.name === selected);
    },
    async use(name) {
      const state = await load();
      if (!state.profiles.some((profile) => profile.name === name))
        throw new Error(`Client profile "${name}" was not found.`);
      state.current = name;
      await save(state);
      return state.profiles.find((profile) => profile.name === name);
    },
    async selectContext(name, context) {
      const state = await load();
      const profile = state.profiles.find((candidate) => candidate.name === name);
      if (!profile) throw new Error(`Client profile "${name}" was not found.`);
      profile.lastContext = contextRef(context);
      await save(state);
      return profile;
    },
    async credentialsFor(profile) {
      if (!profile?.secureCredentialReference) return undefined;
      const value = await credentials.get(profile.secureCredentialReference);
      return value ? credential(value) : undefined;
    },
    async setCredentials(name, value) {
      const state = await load();
      const profile = state.profiles.find((candidate) => candidate.name === name);
      if (!profile) throw new Error(`Client profile "${name}" was not found.`);
      await credentials.set(profile.secureCredentialReference, credential(value));
    },
    async clearCredentials(name) {
      const state = await load();
      const profile = state.profiles.find((candidate) => candidate.name === name);
      if (!profile) throw new Error(`Client profile "${name}" was not found.`);
      await credentials.delete(profile.secureCredentialReference);
    },
  };
}

function credential(value) {
  if (typeof value === 'string' && value) return { accessToken: value };
  if (!value || typeof value !== 'object') throw new Error('Convoy credential is invalid.');
  const result = {};
  if (typeof value.accessToken === 'string' && value.accessToken)
    result.accessToken = value.accessToken;
  if (typeof value.deviceCredential === 'string' && value.deviceCredential)
    result.deviceCredential = value.deviceCredential;
  if (!result.accessToken && !result.deviceCredential)
    throw new Error('Convoy credential is empty.');
  return result;
}

function contextRef(value) {
  if (!value || typeof value !== 'object') throw new Error('Active context is invalid.');
  const result = {
    organizationId: requiredText(value.organizationId, 'organizationId'),
    projectId: requiredText(value.projectId, 'projectId'),
  };
  if (value.teamId !== undefined) result.teamId = requiredText(value.teamId, 'teamId');
  return result;
}

function requiredText(value, label) {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`Discovery ${label} is required.`);
  return value.trim();
}

function slug(value) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 64) || 'convoy'
  );
}

function uniqueName(base, profiles) {
  if (!profiles.some((profile) => profile.name === base)) return base;
  let suffix = 2;
  while (profiles.some((profile) => profile.name === `${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}
