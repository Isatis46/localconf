LocalConf is an English-only, portable LAN conferencing **development preview**.
It is not yet the completed implementation of the architecture or a
production-qualified release.

### Downloads

- **LocalConf-0.1.0-win-x64.zip**: complete Windows portable app, bundled runtime,
  server, documentation, dependency notices and SBOM. Extract the entire ZIP to
  a writable NTFS folder and run `Conference.exe`; do not run inside the ZIP.
- **LocalConf-0.1.0-source.zip**: complete source tree from this exact release tag,
  including tests, locked dependencies, build scripts and architecture documents.
- **SHA256SUMS.txt**: checksums of both bundles. The individual executable-bundle
  `.sha256` file is also attached. This preview is unsigned.

### Included functionality

- Host/client modes, independent rooms, optional room passwords and member limits.
- TLS host certificate pinning, WebRTC SFU audio/video, camera controls and a
  screen/window source picker; connections remain on the local network.
- Host mute/removal, room locking, sharing restrictions and recording permissions.
- Client-only composite WebM recording with public start/stop indicators,
  permission revocation, incremental file writes and SHA-256 metadata.
- Manual IP connection; no cloud account, installer or separate .NET runtime.

### Compatibility and validation

The compatibility **target** is Windows 7 **SP1 x64 with platform/SHA-2 updates**
and later Windows x64. Windows 7 RTM and 32-bit Windows are excluded. The bundled
Electron 22.3.27 and Go 1.20.14 runtimes are legacy versions without current vendor
security support. Use this preview only in a trusted, isolated LAN.

Linux validation passed six Go tests (including the race detector), five Node
network/TLS tests and a two-client browser integration scenario using synthetic
devices. The latter covered audio/video delivery, recording, camera restart and
revocation stopping the guest recorder. The generated WebM was decoded by FFmpeg.
The browser integration used a test IPC bridge; it does not validate Electron 22
or actual Windows hardware. See `docs/validation.md` for precise evidence.

### Still outstanding

- Actual Windows 7/8/10/11 execution and offline first-run testing.
- Physical camera, microphone and screen/window capture qualification.
- 30/100-client capacity tests, real multi-AP networking and one-hour recording.
- Automatic discovery/reconnection, room invitation tokens, adaptive simulcast,
  active-speaker selection, MP4 export and signed/offline updates.

Configured peer limits are **not benchmark results**. See `docs/status.md` and
`docs/windows-qa.md` before relying on this preview for a real meeting.

For LAN setup, permit TCP 8443 and UDP 40000 on the selected host's private
network interface. Compare the complete host fingerprint independently before
trusting it. The app never silently changes firewall rules. WebRTC encryption
terminates at the trusted local SFU; it is not participant-to-participant E2EE.
