import { useEffect, useRef } from 'react'
import type { PointerEvent } from 'react'

interface DragGesture {
  pointerId: number
  startX: number
  startY: number
  moving: boolean
}

export function useOverlayDrag(enabled: boolean) {
  const gesture = useRef<DragGesture | null>(null)
  const frame = useRef<number | null>(null)

  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    if (gesture.current) window.vinxaPhase2?.dragOverlay('end')
    gesture.current = null
  }, [enabled])

  function finish(event: PointerEvent<HTMLElement>): void {
    const current = gesture.current
    if (!current || current.pointerId !== event.pointerId) return
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
    gesture.current = null
    if (current.moving) window.vinxaPhase2.dragOverlay('move')
    window.vinxaPhase2.dragOverlay('end')
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  function onPointerDown(event: PointerEvent<HTMLElement>): void {
    if (!enabled || !event.isPrimary || event.button !== 0 || !(event.target instanceof HTMLElement)) return
    if (event.target.isContentEditable || event.target.closest('button, input, select, textarea, a, [role="button"], [data-no-overlay-drag]')) return
    const root = event.currentTarget.getBoundingClientRect()
    if (event.clientX - root.left < 8 || root.right - event.clientX < 8 || event.clientY - root.top < 8 || root.bottom - event.clientY < 8) return
    const transcript = event.target.closest<HTMLElement>('.transcript')
    if (transcript) {
      const bounds = transcript.getBoundingClientRect()
      const scrollbarWidth = transcript.offsetWidth - transcript.clientWidth
      if (scrollbarWidth > 0 && event.clientX >= bounds.right - scrollbarWidth) return
    }
    event.preventDefault()
    gesture.current = { pointerId: event.pointerId, startX: event.screenX, startY: event.screenY, moving: false }
    event.currentTarget.setPointerCapture(event.pointerId)
    window.vinxaPhase2.dragOverlay('start')
  }

  function onPointerMove(event: PointerEvent<HTMLElement>): void {
    const current = gesture.current
    if (!current || current.pointerId !== event.pointerId) return
    if ((event.buttons & 1) === 0) { finish(event); return }
    if (!current.moving) current.moving = Math.hypot(event.screenX - current.startX, event.screenY - current.startY) >= 4
    if (!current.moving || frame.current !== null) return
    frame.current = requestAnimationFrame(() => {
      frame.current = null
      if (gesture.current?.moving) window.vinxaPhase2.dragOverlay('move')
    })
  }

  return { onPointerDown, onPointerMove, onPointerUp: finish, onPointerCancel: finish, onLostPointerCapture: finish }
}
