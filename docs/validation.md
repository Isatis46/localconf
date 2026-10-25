# Validation performed — 2026-10-25

Environment: Linux x86-64; Go 1.20.14; LLVM-MinGW 20241217 MSVCRT; Node 24.19.
No Windows host, camera, microphone or physical LAN was attached to this session.

## Passed

- **6 Go tests**, including the race detector: HTTP/session validation, room
  password/capacity/scope enforcement, recording permissions/revocation/kick,
  SQLite persistence, certificate identity persistence, and actual DTLS-SRTP
  media forwarding between Pion peers with cross-room subscription rejection.
- **5 Node tests**: private-address validation, credential-free certificate
  inspection, authenticated pinned TLS, rejection of a mismatched pin before any
  application traffic, and fingerprint calculation.
- **Browser integration**, using two Chromium 131 pages, the actual renderer and
  actual Linux server with a test IPC bridge and synthetic devices: host/guest
  join, camera and microphone reception, guest record permission disabled,
  public start/stop recording indicator, local WebM output, camera stop/start
  renegotiation, recording-permission revocation stopping the guest recorder,
  and no uncaught renderer errors.
- A generated recording was probed and fully decoded by FFmpeg: VP8 video,
  1280×720, Opus audio, WebM/Matroska container; no decode error. This was a short
  synthetic recording, not the required one-hour stability test.
- Windows server cross-build produced an x86-64 PE executable with Windows 6.1
  subsystem. Its import table referenced KERNEL32.dll and msvcrt.dll; no separately
  installed VC++ runtime was required by that binary's static import table.
- `build/setup-linux.sh` executed successfully using checksummed tool artifacts,
  frozen npm dependencies and verified Go modules. It produced the portable ZIP.
- ZIP contents were checked against every manifest hash; runtime data/private
  keys were absent; Electron, app files, server, dependency licenses and SBOM
  were present. This integrity check is not code signing.

## Not validated

Electron 22 execution on Windows, real screen/window capture, offline first run,
actual hardware audio/video, Windows ACL behavior, 30/100-client capacity, network
impairment, one-hour A/V synchronization, crash/disk-full recovery and all other
release gates listed in `status.md` and `windows-qa.md`.

Browser tests replace Electron IPC with a test adapter. They validate substantial
renderer/server behavior but do not establish that the shipped desktop process
works on any particular Windows edition. The bundle remains an unsigned preview.
