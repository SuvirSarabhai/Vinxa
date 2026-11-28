import type { SVGProps } from 'react'

const paths = {
  wave: 'M3 10v4m4-8v12m5-16v20m5-16v12m4-8v4',
  play: 'm8 5 11 7-11 7V5Z',
  pause: 'M8 5v14M16 5v14',
  stop: 'M6 6h12v12H6z',
  mic: 'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0V5Zm-3 6v1a6 6 0 0 0 12 0v-1M12 18v4m-4 0h8',
  speaker: 'm11 4-6 5H2v6h3l6 5V4Zm4 4a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14',
  settings:
    'm9 3-1 3-3 1-2 3 2 2-1 3 3 2 2-1 3 2 3-2 2 1 3-2-1-3 2-2-2-3-3-1-1-3H9Zm6 9a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  library: 'M4 3v18M9 3v18M14 3v18m3-17 4 16M2 21h20',
  tools: 'M14 6a5 5 0 0 0-6 6L3 17a3 3 0 0 0 4 4l5-5a5 5 0 0 0 6-6l-3 3-4-4 3-3Z',
  dashboard: 'M3 3h7v7H3zm11 0h7v7h-7zM3 14h7v7H3zm11 0h7v7h-7z',
  transcript: 'M4 3h16v18H4V3Zm4 5h8M8 12h8m-8 4h5',
  overlay: 'M3 4h18v16H3V4Zm8 8h8v6h-8v-6Z',
  collapse: 'm7 8 5 5 5-5M5 19h14',
  expand: 'm7 16 5-5 5 5M5 5h14',
  copy: 'M8 8h13v13H8V8ZM16 4V2H2v14h2',
  shield: 'm12 2 9 4v6c0 5-5 9-9 11-4-2-9-6-9-11V6l9-4Zm-4 10 3 3 5-6',
  arrow: 'm10 5-7 7 7 7M3 12h18',
  check: 'm5 12 4 4L19 6',
  clock: 'M12 8v5l3 2m6-3a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  search: 'm16 16 5 5m-3-11a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
  info: 'M12 11v6m0-11v1m9 5a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z'
} as const

export type IconName = keyof typeof paths
export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: IconName }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d={paths[name]} />
    </svg>
  )
}
