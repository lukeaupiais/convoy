import { mkdtempSync, openSync, writeFileSync, unlinkSync, rmdirSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Linux classic BPF, consumed by bwrap --seccomp. Deny socket creation (all
// families), socketpair and io_uring, including alternate ABI syscall paths.
// Inspection has no network/IPC capability. Unknown architectures fail closed.
export function inspectionFilter(architecture = process.arch) {
  const abi = {
    x64: { audit: 0xc000003e, calls: [41, 53, 425] },
    arm64: { audit: 0xc00000b7, calls: [198, 199, 425] },
  }[architecture];
  if (!abi) throw new Error('Inspection seccomp is unsupported on this architecture.');
  const instructions = [
    [0x20, 0, 0, 4], // load seccomp_data.arch
    [0x15, 1, 0, abi.audit],
    [0x06, 0, 0, 0x80000000], // KILL_PROCESS for alternate ABI
    [0x20, 0, 0, 0], // load syscall number
  ];
  if (architecture === 'x64')
    instructions.push(
      [0x45, 0, 1, 0x40000000], // reject x32 ABI
      [0x06, 0, 0, 0x80000000],
    );
  for (const number of abi.calls)
    instructions.push(
      [0x15, 0, 1, number],
      [0x06, 0, 0, 0x00050001], // EPERM
    );
  instructions.push([0x06, 0, 0, 0x7fff0000]); // ALLOW
  const buffer = Buffer.alloc(instructions.length * 8);
  instructions.forEach(([code, jt, jf, k], i) => {
    buffer.writeUInt16LE(code, i * 8);
    buffer[i * 8 + 2] = jt;
    buffer[i * 8 + 3] = jf;
    buffer.writeUInt32LE(k, i * 8 + 4);
  });
  return buffer;
}
export function openInspectionFilter() {
  const bytes = inspectionFilter();
  const directory = mkdtempSync(join(tmpdir(), 'convoy-seccomp-'));
  const path = join(directory, 'filter');
  let fd;
  try {
    writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' });
    fd = openSync(path, 'r');
  } finally {
    try {
      unlinkSync(path);
    } finally {
      rmdirSync(directory);
    }
  }
  return { fd, close: () => closeSync(fd) };
}
