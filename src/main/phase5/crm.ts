import { createHash } from 'node:crypto'
import type { MeetingStore } from '../db/repository'
import { assertMeetingIdle, deletionPending } from '../delete-meeting'

export function mockCrmEndpoint(input: string): string {
  const url = new URL(input)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.hash || url.search || url.pathname !== '/vinxa/decisions') {
    throw new Error('Use the local mock endpoint http://127.0.0.1:<port>/vinxa/decisions. External CRM delivery is not enabled.')
  }
  return url.toString()
}
export async function sendMockCrm(store: MeetingStore, id: string, endpoint: string, recordId: string, fetcher: typeof fetch = fetch) {
  endpoint = mockCrmEndpoint(endpoint)
  if (deletionPending(store, id)) throw new Error('Meeting deletion is pending.')
  assertMeetingIdle(store, id)
  const detail = store.get(id)
  if (!detail.insights || detail.meeting.notesStatus !== 'completed') throw new Error('Generate and review completed notes before sending them.')
  const payload = { meetingId: id, recordId, decisions: detail.insights.decisions, actionItems: detail.actions }
  const body = JSON.stringify(payload)
  const key = createHash('sha256').update(body).digest('hex')
  store.db.prepare(`INSERT INTO crm_deliveries VALUES (?,?,?,'sending',NULL)
    ON CONFLICT(meetingId,recordId,endpoint) DO UPDATE SET status='sending',sentAt=NULL`).run(id, recordId, endpoint)
  try {
    const response = await fetcher(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body })
    if (!response.ok) throw new Error('Mock CRM rejected the request (HTTP ' + response.status + ').')
    const receipt: unknown = await response.json()
    if (!receipt || typeof receipt !== 'object' || !('accepted' in receipt) || receipt.accepted !== true ||
      !('idempotencyKey' in receipt) || receipt.idempotencyKey !== key) throw new Error('Mock CRM did not acknowledge this delivery.')
    store.db.prepare("UPDATE crm_deliveries SET status='sent',sentAt=? WHERE meetingId=? AND recordId=? AND endpoint=?").run(Date.now(), id, recordId, endpoint)
  } catch {
    store.db.prepare("UPDATE crm_deliveries SET status='failed',sentAt=NULL WHERE meetingId=? AND recordId=? AND endpoint=?").run(id, recordId, endpoint)
    throw new Error('Mock CRM delivery failed or was not acknowledged. Start the mock server and retry; identical retries are deduplicated.')
  }
}
