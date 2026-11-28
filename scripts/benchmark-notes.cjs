require('./register-typescript.cjs')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFile } = require('node:child_process')
const { OllamaNotesProvider } = require('../src/main/insights/ollama.ts')
const { generateNotes } = require('../src/main/insights/service.ts')
const transcript = require('./fixtures/notes-ten-minutes.cjs')
const output = path.resolve('release/phase3-notes-benchmark.json')
const report = { fixture: 'Synthetic 10-minute planning meeting, not a real call', words: transcript.reduce((n,s) => n+s.text.split(/\s+/).length,0),
  date: new Date().toISOString(), platform: os.platform(), cpu: os.cpus()[0]?.model, ramBytes: os.totalmem(),
  chunkCharacters: Number(process.env.VINXA_BENCH_CHUNK_CHARACTERS || 6000),
  timeoutMs: Number(process.env.VINXA_BENCH_TIMEOUT_SECONDS || 180) * 1000, runs: [] }
function memory() {
  if (process.platform !== 'win32') return Promise.resolve(null)
  return new Promise(resolve => execFile('powershell.exe', ['-NoProfile','-NonInteractive','-Command',
    '(Get-Process ollama* -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum).Sum'],
    { windowsHide: true, timeout: 10000 }, (err, text) => resolve(err ? null : Number(text.trim()) || null)))
}
function save() { fs.mkdirSync(path.dirname(output), {recursive:true}); fs.writeFileSync(output, JSON.stringify(report,null,2)) }
async function main() {
  if (!Number.isInteger(report.chunkCharacters) || report.chunkCharacters < 1000 || report.chunkCharacters > 24000 ||
      !Number.isFinite(report.timeoutMs) || report.timeoutMs < 10000 || report.timeoutMs > 600000) throw new Error('Invalid benchmark settings')
  let tags
  try { tags = await (await fetch('http://127.0.0.1:11434/api/tags', {signal:AbortSignal.timeout(5000)})).json() }
  catch { report.blocked = 'Ollama service unavailable'; save(); return }
  const available = tags.models.filter(m => !m.remote_host && !m.remote_model && !/:cloud/.test(m.name))
  const selected = process.argv.slice(2)
  const models = available.filter(m => !selected.length || selected.includes(m.name))
  if (!models.length) { report.blocked = 'No matching installed local models'; save(); return }
  for (const model of models) {
    const run = { model: model.name, digest: model.digest, provider: 'ollama', peakOllamaWorkingSetBytes: null }
    report.runs.push(run); save()
    let sampling = false
    const sample = async () => { if(sampling) return; sampling=true; const bytes=await memory(); if(bytes) run.peakOllamaWorkingSetBytes=Math.max(run.peakOllamaWorkingSetBytes||0,bytes); sampling=false }
    const timer = setInterval(() => void sample(), 2000)
    try {
      // Unload the selected model first so warm-up includes actual load cost.
      await fetch('http://127.0.0.1:11434/api/generate', {method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({model:model.name, keep_alive:0}),signal:AbortSignal.timeout(30000)})
      const provider = new OllamaNotesProvider(model.name, report.timeoutMs)
      console.log('Warm-up ' + model.name)
      const started = performance.now()
      const warmup = await generateNotes(provider, [transcript[0]], report.chunkCharacters)
      run.warmup = {wallMs: performance.now()-started, ...warmup}
      save()
      console.log('10-minute fixture ' + model.name)
      const begin = performance.now()
      const measured = { name: provider.name, model: provider.model, available: () => provider.available(),
        async generate(request) { const result=await provider.generate(request); console.log(model.name+' response '+Math.round(result.metrics.durationMs)+' ms'); return result } }
      run.result = await generateNotes(measured, transcript, report.chunkCharacters)
      run.totalMs = performance.now()-begin
      run.validation = run.result.status === 'completed' ? 'PASS' : 'FAIL'
      run.retries = run.result.metrics.filter(m => m.retries > 0).length
      run.tokens = run.result.metrics.some(m => m.inputTokens !== undefined || m.outputTokens !== undefined)
        ? run.result.metrics.reduce((sum,m)=>sum+(m.inputTokens||0)+(m.outputTokens||0),0) : null
    } catch (error) { run.error=String(error); run.validation='FAIL' }
    finally {
      clearInterval(timer); await sample(); save()
      await fetch('http://127.0.0.1:11434/api/generate', {method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({model:model.name,keep_alive:0}),signal:AbortSignal.timeout(30000)}).catch(()=>undefined)
    }
    console.log(model.name+' '+run.validation)
  }
  console.log(output)
}
main().catch(error => { report.error=String(error); save(); process.exitCode=1 })
