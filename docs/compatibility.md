# Compatibility decision

The owner requested an English-only interface and Windows 7 or newer, and
approved changing the original WPF/.NET 10/native bridge architecture.

The implementation uses Electron **22.3.27** (Chromium's native WebRTC, desktop
capture and media codecs), Go **1.20.14**, and Pion **3.2.40**. Electron 22 and Go
1.20 are the last release families supporting Windows 7. This is a legacy
compatibility target, not a claim of current vendor support or security parity
with a modern runtime. Use only on a trusted, isolated LAN. No remote web content,
CDN, analytics, STUN/TURN, runtime downloads, or auto-updater are used.

Target: Windows 7 **SP1 x64 with platform/SHA-2 updates**, Windows 8/8.1 x64,
Windows 10/11 x64. Windows 7 RTM and 32-bit Windows are not supported. Actual
execution, hardware capture/codec behavior and offline startup on each OS must
be checked on Windows before declaring that OS validated.

Chromium chooses a compatible camera codec (VP8/H.264); screen capture uses its
OS-compatible desktop capture rather than Windows.Graphics.Capture. The first
recording implementation writes a local, incrementally flushed **WebM** file
(Matroska family, VP8/Opus). It does not mislabel WebM as MP4 or promise H.264
hardware acceleration. MP4 export, a native GPU recording compositor, adaptive
simulcast and Windows-specific performance qualification remain release gates.

The server routes encrypted WebRTC media without decoding. TLS certificate
pinning authenticates the selected host; DTLS-SRTP protects each client-to-server
leg. This is not end-to-end encryption between participants. The server is trusted.

See `status.md` for precise implemented and unvalidated functionality.
