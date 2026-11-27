import { useEffect, useState } from 'react'
import type { Phase2Command, Phase2Snapshot } from '../../../shared/phase2'

export type CommandHandler = (command: Phase2Command) => Promise<boolean>

export function timestamp(milliseconds: number): string {
  const total = Math.floor(Math.max(0, milliseconds) / 1000)
  const seconds = String(total % 60).padStart(2, '0')
  const minutes = String(Math.floor(total / 60) % 60).padStart(2, '0')
  return total >= 3600
    ? `${String(Math.floor(total / 3600)).padStart(2, '0')}:${minutes}:${seconds}`
    : `${minutes}:${seconds}`
}

export function useSession() {
  const [snapshot, setSnapshot] = useState<Phase2Snapshot | null>(null)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(0)
  useEffect(() => {
    const api = window.vinxaPhase2
    if (!api) {
      setError('Desktop bridge unavailable. Restart Vinxa.')
      return
    }
    let cancelled = false
    const accept = (incoming: Phase2Snapshot): void => {
      if (!cancelled)
        setSnapshot((previous) => (!previous || incoming.revision >= previous.revision ? incoming : previous))
    }
    const unsubscribe = api.onChange(accept)
    void api
      .snapshot()
      .then(accept)
      .catch(() => {
        if (!cancelled) setError('Could not load the session. Restart Vinxa.')
      })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const command: CommandHandler = async (value) => {
    setPending((previous) => previous + 1)
    setError('')
    try {
      await window.vinxaPhase2.command(value)
      return true
    } catch {
      setError('The action could not be completed. Check the session message or try again.')
      return false
    } finally {
      setPending((previous) => previous - 1)
    }
  }
  return {
    snapshot,
    command,
    busy: !snapshot?.ready || snapshot.busy || pending > 0,
    error: snapshot?.error || error
  }
}

export function useDuration(snapshot: Phase2Snapshot): string {
  const [now, setNow] = useState(Date.now())
  const running = snapshot.startedAtMs != null && snapshot.endedAtMs == null
  useEffect(() => {
    if (!running) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running, snapshot.startedAtMs])
  return timestamp(snapshot.startedAtMs == null ? 0 : (snapshot.endedAtMs ?? now) - snapshot.startedAtMs)
}
