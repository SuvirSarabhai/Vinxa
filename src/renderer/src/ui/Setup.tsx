import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { RecordingConfig } from '../../../shared/contracts'
import type { Phase2Snapshot } from '../../../shared/phase2'
import { Icon } from './Icon'
import { ModeBadge } from './SessionWidgets'
import type { CommandHandler } from './session'

export function Setup({
  snapshot,
  command,
  busy,
  error
}: {
  snapshot: Phase2Snapshot
  command: CommandHandler
  busy: boolean
  error: string
}) {
  const [config, setConfig] = useState<RecordingConfig>(snapshot.config)
  const [consent, setConsent] = useState(false)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [deviceMessage, setDeviceMessage] = useState(
    'Device names may stay hidden until microphone permission is granted. Capture starts after consent.'
  )
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    let cancelled = false
    const media = navigator.mediaDevices
    async function refresh(): Promise<void> {
      if (!media?.enumerateDevices) {
        setDeviceMessage('Device discovery is unavailable. Use System default.')
        return
      }
      try {
        const available = await media.enumerateDevices()
        if (!cancelled)
          setDevices(available.filter((device) => device.kind === 'audioinput' && device.deviceId))
      } catch {
        if (!cancelled) setDeviceMessage('Device names are unavailable. Use System default.')
      }
    }
    void refresh()
    media?.addEventListener('devicechange', refresh)
    return () => {
      cancelled = true
      media?.removeEventListener('devicechange', refresh)
    }
  }, [])
  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (consent) void command({ type: 'confirm', config, consent: true })
  }
  return (
    <main className="setup-shell">
      <header className="setup-heading">
        <span className="brand-mark">
          <Icon name="wave" />
        </span>
        <span>Vinxa · Setup and consent</span>
        <ModeBadge snapshot={snapshot} />
      </header>
      <div className="setup-content">
        <p className="eyebrow">BEFORE YOU BEGIN</p>
        <h1>Prepare local session</h1>
        <p className="muted">Choose what to capture. Let everyone know before you start.</p>
        {snapshot.mode === 'demo' && (
          <p className="notice">
            This demo plays written sample text. No microphone or system audio is captured.
          </p>
        )}
        {error && (
          <p className="error message" role="alert">
            {error}
          </p>
        )}
        <form onSubmit={submit}>
          <label className="field">
            Meeting title
            <input
              required
              maxLength={160}
              value={config.title}
              disabled={busy}
              placeholder="Give this meeting a name"
              onChange={(event) => setConfig({ ...config, title: event.target.value })}
            />
          </label>
          <label className="field">
            Microphone
            <select
              value={config.microphoneDeviceId ?? ''}
              disabled={!config.microphoneEnabled || busy}
              onChange={(event) => setConfig({ ...config, microphoneDeviceId: event.target.value || null })}
            >
              <option value="">System default</option>
              {devices.map((device, index) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `Microphone ${index + 1}`}
                </option>
              ))}
            </select>
            <small className="field-help">{deviceMessage}</small>
          </label>
          <fieldset className="audio-options">
            <legend>Audio sources</legend>
            <label className="check">
              <input
                type="checkbox"
                checked={config.microphoneEnabled}
                disabled={busy}
                onChange={(event) => setConfig({ ...config, microphoneEnabled: event.target.checked })}
              />
              <Icon name="mic" />
              <span>Include microphone</span>
            <small>Inactive</small>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={config.systemAudioEnabled}
                disabled={busy}
                onChange={(event) => setConfig({ ...config, systemAudioEnabled: event.target.checked })}
              />
              <Icon name="speaker" />
              <span>Include system audio</span>
              <small>Inactive</small>
            </label>
            <p className="field-help">
              Meters remain inactive until consent is confirmed. System audio uses Windows default output.
            </p>
          </fieldset>
          <section className="privacy-notice">
            <Icon name="shield" />
            <div>
              <h2>Local processing</h2>
              <p>
                {snapshot.mode === 'demo'
                  ? 'The sample runs locally without opening audio devices.'
                  : 'Selected audio and transcripts are saved on this laptop. Microphone and system audio are stored separately. Cloud notes use transcript text only when enabled in Settings.'}
              </p>
              <p>
                <strong>Meeting-app mute does not mute Vinxa.</strong> Nearby voices can be captured. Use
                Pause, Stop, or disable the microphone source.
              </p>
            </div>
          </section>
          <div className="announcement-row">
            <div>
              <h2>Let participants know</h2>
              <p className="muted">Copy an announcement to share in your meeting chat.</p>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                if (await command({ type: 'copy-announcement' })) setCopied(true)
              }}
            >
              <Icon name={copied ? 'check' : 'copy'} />
              Copy meeting announcement
            </button>
          </div>
          {copied && (
            <p className="success" role="status">
              Copied. Review the announcement before sharing it.
            </p>
          )}
          <label className="check consent">
            <input
              type="checkbox"
              checked={consent}
              disabled={busy}
              onChange={(event) => setConsent(event.target.checked)}
            />
            <span>I confirm that participants have been informed and consent has been obtained.</span>
          </label>
          {!config.microphoneEnabled && !config.systemAudioEnabled && (
            <p className="error" role="alert">
              Select at least one audio source.
            </p>
          )}
          <div className="form-actions">
            <button type="button" disabled={busy} onClick={() => void command({ type: 'cancel' })}>
              Cancel
            </button>
            <button
              className="primary"
              type="submit"
              disabled={
                busy ||
                !snapshot.engine.ready ||
                !consent ||
                !config.title.trim() ||
                (!config.microphoneEnabled && !config.systemAudioEnabled)
              }
            >
              <Icon name="play" />
              {busy ? 'Starting…' : snapshot.mode === 'demo' ? 'Confirm and start demo' : 'Confirm and start'}
            </button>
          </div>
        </form>
      </div>
    </main>
  )
}
