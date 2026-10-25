# Preview implementation status

This repository is an implementation in progress against the supplied architecture,
with the owner's approved technology change for Windows 7+ and English-only UI.

## Implemented

- Bundled Electron UI and native Chromium capture/WebRTC; sandboxed renderer with
  context isolation, restrictive CSP, narrow IPC, and remote navigation blocked.
- Portable host child process, selected private IPv4 interface, TLS >=1.2,
  persistent certificate, exact SHA-256 pin verification before authenticated traffic.
- Go/Pion SFU with UDP mux on 40000, separate send/receive connections, no external
  ICE servers, default RTP/RTCP interceptors and PLI feedback to the publisher.
- SQLite WAL room persistence, Argon2id room passwords, opaque expiring sessions,
  host privileges, room/password/capacity checks, locking, kick and token revocation.
- Server-side media scope checks, audio mute enforcement, share restrictions,
  one screen per room, maximum 4 remote camera + 1 screen subscriptions per client.
- Room-wide recording state including late joiners, host permission grant/revoke;
  local 720p/25fps canvas composition, decoded audio mix, VP8/Opus WebM, incremental
  disk writes/flush, partial files and final SHA-256 metadata.
- Device selection, explicit screen/window picker, manual host IP, basic receive
  statistics, graceful child shutdown, unsigned ZIP and dependency notices/SBOM.

## Not complete / release gates

- No Windows 7/8/10/11 execution or real GPU/webcam/microphone validation yet.
- No capacity claim: 30/100-client benchmarks and real multi-AP testing not run.
- No one-hour recording, A/V drift, disk-full, sleep/resume or hardware-device
  change qualification. WebM crash recovery is best effort, not guaranteed.
- No automatic mDNS discovery, expiring room invites, automatic reconnect/ICE
  restart, active-speaker selection, simulcast/layer adaptation or per-stream pin UI.
- No MP4 export, mandatory H.264 hardware encoding, native GPU recording compositor,
  segmented recordings, full diagnostics dashboard, or client SQLite preferences.
- No signed/offline update, publisher code signing, penetration test/fuzz campaign,
  complete resource/DoS hardening, or production security qualification.
- Host IPC uses an inherited private stdin pipe, not the original named-pipe design.
- Sessions expire after 8 hours and require reconnecting; no session renewal yet.
- Room password controls entry; guests with network access can create a guest
  identity and see room titles. There is no organizational account directory.
- Current audit retention is not yet configurable; administrators should protect
  the host data folder and manage retention outside active meetings.

Do not advertise this preview as the completed product or as a security-supported
Windows 7 application. A working packet-forwarding test does not establish the
full acceptance criteria in the architecture.
