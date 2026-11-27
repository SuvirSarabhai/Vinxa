export function CaptureDiagnostic() {
  return (
    <main className="shell">
      <p className="eyebrow">VINXA / REAL AUDIO DIAGNOSTIC</p>
      <h1>Audio capture diagnostic</h1>
      <p className="notice">This mode can record real microphone and system audio into local WAV files.</p>
      <section className="panel">
        <h2>Use the recording dialog</h2>
        <p>Capture begins only after you choose Start audio test in the native consent dialog. Use Stop recording there to finalize the files, or wait for the diagnostic timeout.</p>
        <p>The dialog reports recording status, errors, and the output directory. Existing recordings are preserved.</p>
        <p className="muted">The Phase 2 demo controls and global shortcuts are disabled in this mode. No live transcript is connected.</p>
      </section>
      <footer>To return to demo mode, quit Vinxa, clear VINXA_CAPTURE_TEST in your terminal, and restart the app.</footer>
    </main>
  )
}
