# Desktop builds

Convoy's desktop host starts the same durable daemon used by `npm run server`,
then opens the built web UI at its loopback origin. The Electron renderer has no
Node bridge. Approvals, leases, runner assignments, and recovery remain daemon
rules. Closing the window stops the daemon cleanly; a failed daemon startup or
unexpected exit is shown as an error.

## Run from source

Install Node.js 22+, npm, Git, and Bun (for release worker builds). On Linux,
install Bubblewrap and tmux for contained local execution and native terminals.
Building the Arch pacman package also needs `libxcrypt-compat` for
electron-builder's bundled packaging tool.

```sh
npm ci
npm run desktop:dev
```

The development command downloads the matching Electron binary if needed, starts
Vite at `127.0.0.1:5173`, and opens Electron. Edits to the web UI update through
Vite hot reload. Edits to desktop, daemon, or runner `.mjs` files restart Electron
and its daemon. Closing the window or pressing Ctrl+C stops both processes.

To check the built UI and production desktop entry from source, run
`npm run desktop`. This builds the web UI before launch; it does not watch files.
The source desktop uses the repository's `.convoy/` state and `dist-worker/`
artifacts. Its daemon binds to `127.0.0.1:4317`; stop a separately running daemon
before launching it. Close any other Convoy desktop window before using
`desktop:dev`, since Electron runs one instance at a time. The browser
development workflow still uses `npm run server` and `npm run dev`. Installed
releases have no live update channel yet.

## Package

```sh
npm run package:desktop -- --linux AppImage pacman
```

Output goes to `desktop-dist/`. The command builds both supported Linux SSH
workers and puts them in the app's resources. On Arch, the pacman package is the
native installer; AppImage is the portable Linux target. Run the same packaging
command on Windows with `--win nsis` and on macOS with `--mac dmg`. A release
builder needs Bun to compile the Linux SSH worker artifacts, including when it
packages the Windows or macOS coordinator.

Installed state lives under Electron's per-user application data directory in
`.convoy/`. A source checkout's `.convoy/` is not migrated automatically. Back up
or copy it only while both daemons are stopped. Installed releases use their
bundled immutable worker artifacts; they do not use a checkout's `dist-worker/`.

The desktop host itself can run on Linux, Windows, and macOS. Contained local
execution and the native terminal currently require Linux tools (`bwrap` and
`tmux`), so use a Linux SSH runner for those workflows from Windows or macOS.
Local trusted execution is an explicit runner policy and should be selected only
for a host you trust. Android and iOS are future clients of the daemon protocol;
these desktop packages do not target mobile operating systems.

## Release checks

Run `npm run check:architecture`, `npm run build`, and the tests before packaging.
Install and smoke test each target on its native operating system, including Arch
pacman installation, launch, daemon restart, UI/API, SSH runner connection, and
an interrupted operation. Check the actual app resources contain `dist/`, daemon
source, runtime dependencies, and `dist-worker/`. The manual `Desktop package
checks` GitHub workflow builds unsigned test artifacts on all three native CI
hosts. Version and ship updates manually. Public Windows and macOS distribution
also needs platform signing and macOS notarization credentials; no signing or
automatic update channel is configured yet. Do not treat an unsigned cross-built
artifact as a release.
