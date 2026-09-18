/** The IPC contract, shared by main and preload. */
export const CHANNELS = {
  scan: 'board:scan',
  sessionsPushed: 'board:sessions',
  notesLoad: 'board:notes:load',
  notesSet: 'board:notes:set',
  configLoad: 'board:config:load',
  configSave: 'board:config:save',
  resumeCommand: 'board:resume-command',
  deletePanel: 'board:delete-panel',
  bulkDeletePanel: 'board:bulk-delete-panel',
  openTerminal: 'board:open-terminal',
  focusTty: 'board:focus-tty',
  openExternal: 'board:open-external',
} as const
