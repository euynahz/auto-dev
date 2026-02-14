// Unified console logger with consistent format
// Format: HH:MM:SS [TAG] message

const gray = '\x1b[90m'
const reset = '\x1b[0m'
const cyan = '\x1b[36m'
const yellow = '\x1b[33m'
const red = '\x1b[31m'
const green = '\x1b[32m'
const magenta = '\x1b[35m'

function ts(): string {
  return gray + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + reset
}

function tag(label: string, color: string): string {
  return `${color}[${label}]${reset}`
}

export const log = {
  server: (msg: string) => console.log(`${ts()} ${tag('SERVER', cyan)} ${msg}`),
  ws:     (msg: string) => console.log(`${ts()} ${tag('WS', cyan)} ${msg}`),
  api:    (msg: string) => console.log(`${ts()} ${tag('API', green)} ${msg}`),
  agent:  (msg: string) => console.log(`${ts()} ${tag('AGENT', magenta)} ${msg}`),
  git:    (msg: string) => console.log(`${ts()} ${tag('GIT', yellow)} ${msg}`),
  project:(msg: string) => console.log(`${ts()} ${tag('PROJECT', green)} ${msg}`),
  watch:  (msg: string) => console.log(`${ts()} ${tag('WATCH', yellow)} ${msg}`),
  warn:   (msg: string) => console.warn(`${ts()} ${tag('WARN', yellow)} ${msg}`),
  error:  (msg: string) => console.error(`${ts()} ${tag('ERROR', red)} ${msg}`),
}
