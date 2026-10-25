# Windows release qualification checklist

Record OS edition/build, CPU/GPU/driver, RAM, network adapter/AP, room layout,
recording device and package SHA-256 for every run. Results are currently pending.

1. On clean Windows 7 SP1 x64 with platform/SHA-2 updates and on Windows 11,
   disconnect internet, extract to writable NTFS, start without separate runtimes.
   Repeat as a non-admin user and from a removable NTFS drive.
2. Start the host on the selected NIC; verify TCP 8443 and UDP 40000 firewall
   behavior, graceful shutdown, persisted rooms and stable certificate identity.
3. Join from another machine, compare the complete fingerprint, verify an altered
   host certificate is blocked, and test wrong room passwords and capacity limits.
4. In two simultaneous rooms, send microphone, camera and a selected screen/window.
   Verify there is no media between rooms. Test screen ownership and share revoke.
5. Verify host mute actually stops received audio; test recording grant, revoke,
   kick, late joiners during recording and room locking.
6. Test different microphones/speakers, camera unplug, HDMI removal, DPI/monitor
   resize, sleep/resume and 10-second network interruption. Current reconnect is
   manual; record shortcomings rather than marking them passed.
7. Record for 60 minutes with speaking, screen motion and cameras. Play the file
   in a WebM-capable player; measure A/V drift, CPU/GPU and dropped frames. Test
   low disk space and process interruption; preserve the partial file.
8. Scale 10 → 30 → 50 → 100 authenticated clients in independent rooms. For the
   100-user reference, use four rooms of 25 and the architecture's media profile.
   Measure successful joins, p95 latency, loss, bandwidth, CPU and memory. Do not
   infer 100-camera capacity from the configured peer limit.
9. Exercise 1/3/5% packet loss, jitter, constrained bandwidth and multiple APs;
   document degradation and any need for the unfinished adaptation mechanisms.
10. Review bundled licenses, code-signing, dependency vulnerabilities, diagnostics
    redaction and the remaining gates in `status.md` before a production release.
