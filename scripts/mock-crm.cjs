// Memory-only local demo receiver. No transcript, audio, credentials or payload logs.
const http = require('node:http')
const crypto = require('node:crypto')
const receipts = new Map()
const port = Number(process.env.VINXA_MOCK_CRM_PORT || 4319)
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid mock CRM port')
http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json')
  if (req.method !== 'POST' || req.url !== '/vinxa/decisions') { res.writeHead(404).end('{}'); return }
  try {
    let bytes = 0; const parts = []
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 1024 * 1024) throw new Error(); parts.push(chunk) }
    const body = Buffer.concat(parts).toString('utf8'), data = JSON.parse(body)
    const key = crypto.createHash('sha256').update(body).digest('hex')
    if (req.headers['idempotency-key'] !== key || typeof data.recordId !== 'string' || typeof data.meetingId !== 'string' ||
      !Array.isArray(data.decisions) || !Array.isArray(data.actionItems)) throw new Error()
    const duplicate = receipts.has(key)
    if (!duplicate && receipts.size >= 10000) { res.writeHead(503).end('{}'); return }
    receipts.set(key, true)
    res.end(JSON.stringify({ accepted: true, idempotencyKey: key, duplicate }))
  } catch { res.writeHead(400).end('{}') }
}).listen(port, '127.0.0.1', () => console.log(`Mock CRM listening on http://127.0.0.1:${port}/vinxa/decisions (memory only)`))
