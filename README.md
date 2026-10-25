# LocalConf

English-only, portable LAN conferencing for Windows x64. This is a **development
preview**, not a production-qualified implementation of the full architecture.

## Run the Windows preview

1. Extract the **entire** `LocalConf-0.1.0-win-x64.zip` to a writable **NTFS** folder.
   Do not run inside the ZIP or copy only the EXE. No installation, .NET runtime,
   cloud account or first-run internet connection is required by the package.
2. Open `Conference.exe`. Enter your display name.
3. On one computer, choose its LAN interface and **Start host**. If Windows asks,
   allow access on the **Private** network. TCP **8443** and UDP **40000** must be
   reachable from participants. Firewall rules are never changed automatically.
4. Create a room, optionally protected by a password. Share the host IP address
   and the displayed SHA-256 fingerprint through a trusted channel.
5. On the other computers, use **Join a host**, enter that IP, independently
   compare the fingerprint, connect, and join the room.
6. Enable microphone/camera or choose a screen/window. Use headphones. The host
   can mute, remove, restrict sharing, lock a room, and grant recording permission.
7. **Record locally** writes a composite WebM video and mixed audio to the selected
   computer. A visible room-wide recording indicator includes late joiners.
   Stop recording before moving the file. A JSON sidecar records timestamps and
   SHA-256. An interrupted `.partial.webm` may be recoverable but is not guaranteed.

The host is also a participant. Keep the host app open throughout the meeting.
Its child server exits when the parent closes its private stdin control pipe.
Public Wi-Fi/client isolation and blocked UDP can prevent media even when the
room list works. No TURN server or internet fallback is configured.

**Compatibility target:** Windows 7 SP1 x64 with platform/SHA-2 updates and newer
Windows x64. Windows 7 RTM and 32-bit systems are excluded. This target has **not
yet been validated on Windows hardware**. The legacy Electron/Go runtimes are
out of security support. See [compatibility](docs/compatibility.md).

## Current functionality and limitations

Implemented: HTTPS/WSS with explicit host certificate pinning, persistent SQLite
rooms and Argon2id passwords, room authorization/capacity, WebRTC SFU forwarding,
camera/microphone/desktop source controls, receive caps (4 cameras + 1 screen),
host controls, per-client recording permission, visible recording state, composite
local WebM recording, and portable packaging with dependency notices/checksums.

Manual IP connection is implemented. Automatic discovery, room invitation tokens,
automatic reconnection/ICE restart, adaptive simulcast/active-speaker selection,
MP4 export, signed releases/offline update, and the full 100-person/one-hour QA
matrix remain outstanding. **Configured limits are not benchmark results.**
See [implementation status](docs/status.md) and [Windows test checklist](docs/windows-qa.md).

## Build and test

Build dependencies (development machine only): Python 3, Node >=18, OpenSSL,
**Go 1.20.14**, and a Windows x64 C cross compiler targeting **MSVCRT/Windows 7**
for the bundled SQLite C implementation. The Linux build used LLVM-MinGW
`20241217-msvcrt-ubuntu-20.04-x86_64`. Do not use a newer Go compiler for this
legacy target. Dependencies are pinned in `package-lock.json` and `src/server/go.sum`.

```sh
npm ci --ignore-scripts
npm test
cd src/server
go test -race ./...
go build -o ../../artifacts/conference-server-linux .
cd ../..
python3 build/package.py --go /path/to/go1.20.14/bin/go \
  --cc /path/to/llvm-mingw/bin/x86_64-w64-mingw32-clang
```

`build/package.py` verifies the Electron archive against the pinned upstream
SHA-256, cross-builds the server, bundles the runtime and production Node module,
collects dependency licenses/SBOM, and writes a ZIP plus checksum in `artifacts/`.
It never includes user data or recordings. `manifest.json` detects an accidentally
mismatched server; it is **not** a publisher signature or a defense against an
attacker replacing both files. This preview is unsigned and may trigger SmartScreen.

For Linux browser integration tests, build the Linux server above, install
`@sparticuz/chromium@131.0.1` and `puppeteer-core@23.11.1` in a separate test folder,
and set `NODE_PATH` to its `node_modules` before `npm run test:browser`. The test
uses synthetic devices and the real renderer/server; it does not replace testing
Electron 22 or Windows hardware.

## Data and privacy

`data/host/server.db` stores room definitions and audit metadata; media packets are
never recorded by the server. `data/host/host.key` is the host's long-lived private
identity. `data/trusted-hosts.json` holds public trusted certificates. On Windows,
the application restricts the data directory ACL to the current user. NTFS is
required for those ACLs. Moving a USB folder to another Windows account may require
restoring ownership; moving/copying private host identity makes the destination a
trusted host, so protect backups. Tokens exist in process memory, not settings.

WebRTC encryption terminates at the trusted SFU. It is not participant-to-participant
E2EE. The app controls its own recorder; it cannot prevent OS-level screen capture.
No application telemetry, cloud services, remote pages, CDN assets or automatic
runtime downloads are used. Client logs do not include tokens or complete SDP.
