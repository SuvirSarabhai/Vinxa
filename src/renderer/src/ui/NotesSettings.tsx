import { useEffect, useState } from 'react'
import { notesSettingsSchema } from '../../../shared/meetings'
import type { NotesSettings as Settings } from '../../../shared/meetings'
export function NotesSettings() {
  const [settings, setSettings] = useState<Settings>(notesSettingsSchema.parse({}))
  const [key, setKey] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [clearKey, setClearKey] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void window.vinxaMeetings.settings().then(value => {
      if (active) {
        const { apiKeyConfigured, ...saved } = value
        setSettings(saved); setHasKey(apiKeyConfigured); setLoaded(true)
      }
    }).catch(() => { if (active) setError('Notes settings could not be loaded.') })
    return () => { active = false }
  }, [])
  return <section className="panel notes-settings">
    <h2>Meeting notes</h2>
    <p className="muted">Local-only is the default. Configure an installed Ollama model to generate notes on this laptop.</p>
    <form onSubmit={event => {
      event.preventDefault(); setBusy(true); setError(''); setNotice('')
      void window.vinxaMeetings.saveSettings({ ...settings, ...(key ? { apiKey: key } : {}), clearApiKey: clearKey }).then(value => {
        const { apiKeyConfigured, ...saved } = value
        setSettings(saved); setHasKey(apiKeyConfigured); setKey(''); setClearKey(false); setNotice('Notes settings saved.')
      }).catch(error => setError(error instanceof Error ? error.message : 'Settings could not be saved.')).finally(() => setBusy(false))
    }}>
      <label className="field">Speech model size<select value={settings.speechModel} disabled={!loaded || busy}
        onChange={event => setSettings({ ...settings, speechModel: notesSettingsSchema.shape.speechModel.parse(event.target.value) })}>
        <option value="default">Startup default</option><option value="tiny.en">Tiny English</option>
        <option value="base.en">Base English</option><option value="small">Small multilingual</option>
      </select></label>
      <p className="field-help">Select an installed speech model. Save, then quit Vinxa from the tray and reopen it to apply.</p>
      <label className="field">Notes provider<select aria-label="Notes provider" value={settings.provider} disabled={!loaded || busy}
        onChange={event => setSettings({ ...settings, provider: event.target.value === 'openai' ? 'openai' : 'ollama' })}>
        <option value="ollama">Ollama · local-only</option><option value="openai">OpenAI · opt-in cloud notes</option>
      </select></label>
      <label className="field">Ollama model<input aria-label="Ollama model" value={settings.ollamaModel} disabled={!loaded || busy} placeholder="Installed model name"
        onChange={event => setSettings({ ...settings, ollamaModel: event.target.value })} /></label>
      <p className="field-help">Ollama runs at 127.0.0.1 on port 11434. If the service or model is missing, notes stay pending.</p>
      <label className="check"><input type="checkbox" checked={settings.cloudEnabled} disabled={!loaded || busy}
        onChange={event => setSettings({ ...settings, cloudEnabled: event.target.checked })} />
        I explicitly allow meeting transcript text to be sent to OpenAI for notes when OpenAI is selected.</label>
      <p className="field-help">Audio stays on this laptop. Local-only mode uses Ollama. OpenAI notes require both this consent and OpenAI as the selected provider.</p>
      <label className="field">OpenAI model<input aria-label="OpenAI model" value={settings.openaiModel} disabled={!loaded || busy}
        onChange={event => setSettings({ ...settings, openaiModel: event.target.value })} /></label>
      <label className="field">OpenAI API key<input aria-label="OpenAI API key" type="password" autoComplete="off" value={key} disabled={!loaded || busy}
        placeholder={hasKey ? 'A key is securely stored' : 'Enter your key'} onChange={event => { setKey(event.target.value); setClearKey(false) }} /></label>
      {hasKey && <label className="check"><input type="checkbox" checked={clearKey} disabled={busy}
        onChange={event => { setClearKey(event.target.checked); setKey('') }} />Remove the stored API key</label>}
      <label className="field">Transcript characters per chunk<input type="number" min={1000} max={24000} value={settings.chunkCharacters}
        onChange={event => setSettings({ ...settings, chunkCharacters: Number(event.target.value) })} /></label>
      <label className="field">Provider timeout in seconds<input type="number" min={10} max={600} value={settings.timeoutSeconds}
        onChange={event => setSettings({ ...settings, timeoutSeconds: Number(event.target.value) })} /></label>
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="success" role="status">{notice}</p>}
      <button className="primary" disabled={!loaded || busy}>{busy ? 'Saving…' : 'Save notes settings'}</button>
    </form>
  </section>
}
