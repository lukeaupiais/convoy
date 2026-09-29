// Runs inside the prospective sandbox using the worker's own runtime. The
// compiled worker dispatches this before starting RPC or process supervisors.
export async function runInspectionProbe(expectDenied = true) {
  const { writeFile } = await import('node:fs/promises');
  const { createServer } = await import('node:net');
  let readOnly = false;
  try {
    await writeFile('/workspace/.inspection-write-probe', 'probe');
  } catch (error) {
    readOnly = error.code === 'EROFS';
  }
  if (!readOnly) throw new Error('Workspace is not mounted read-only.');
  const forbidden = (options) =>
    new Promise((resolve, reject) => {
      const server = createServer();
      server.once('error', (error) => (expectDenied ? resolve() : reject(error)));
      server.listen(options, () =>
        server.close(() =>
          expectDenied ? reject(new Error('Socket creation was allowed.')) : resolve(),
        ),
      );
    });
  await forbidden({ path: '/tmp/convoy-inspection-probe.sock' });
  await forbidden({ host: '127.0.0.1', port: 0 });
}
