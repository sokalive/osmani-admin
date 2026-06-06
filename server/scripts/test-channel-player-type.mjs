import { channelToResponse, normalizePlayerType, parseChannelInput } from '../src/channelNormalize.js'

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const legacy = ['exo', 'webview', 'vlc', 'native', 'ijk']
for (const t of legacy) {
  assert(normalizePlayerType(t) === t, `legacy ${t}`)
  assert(normalizePlayerType(t.toUpperCase()) === t, `legacy upper ${t}`)
}

assert(normalizePlayerType('chrome') === 'chrome', 'chrome lowercase')
assert(normalizePlayerType('Chrome') === 'chrome', 'chrome mixed')
assert(normalizePlayerType('googlechrome') === 'chrome', 'googlechrome alias')
assert(normalizePlayerType('bogus') === 'exo', 'unknown falls back to exo')

const parsed = parseChannelInput({ name: 'Test', url: 'https://example.com/stream', playerType: 'chrome' })
assert(parsed.playerType === 'chrome', 'parseChannelInput chrome')

const api = channelToResponse(
  {
    id: 99,
    name: 'Chrome Test',
    url: 'https://example.com/stream',
    playerType: 'chrome',
    category: 'Home',
    bottomTab: 'Home',
    accessType: 'free',
    isLive: true,
    isHD: true,
    isActive: true,
    showInApp: true,
    sortOrder: 0,
    authorizedPackageName: 'MWENZI 1',
  },
  { headers: {}, protocol: 'https', get: () => 'localhost' },
)
assert(api.playerType === 'chrome', 'API response playerType chrome')
assert(api.authorizedPackageName === 'MWENZI 1', 'mpingo field preserved')

console.log('All channel player type tests passed.')
