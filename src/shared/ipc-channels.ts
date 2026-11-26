export const ipcChannels = {
  recordingStart: 'recording:start', recordingPause: 'recording:pause',
  recordingResume: 'recording:resume', recordingStop: 'recording:stop',
  meetingsList: 'meetings:list', meetingsGet: 'meetings:get', meetingsSearch: 'meetings:search',
  meetingsDelete: 'meetings:delete', meetingsExport: 'meetings:export', meetingsRename: 'meetings:rename',
  speakerRename: 'speaker:rename', settingsGet: 'settings:get', settingsSet: 'settings:set',
  recordingState: 'event:recording-state', transcriptSegment: 'event:transcript-segment',
  audioLevel: 'event:audio-level', engineStatus: 'event:engine-status',
  insightsReady: 'event:insights-ready', errorRaised: 'event:error',
  fixtureCommand: 'fixture:command', fixtureStatus: 'fixture:status'
} as const
