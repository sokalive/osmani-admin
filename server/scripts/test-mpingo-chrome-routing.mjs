/**
 * Mpingo Widevine channels must route to chrome player (WebView lacks Widevine EME).
 */
import assert from 'node:assert/strict'
import { channelToResponse } from '../src/channelNormalize.js'
import {
  __clearMpingoMetadataCacheForTest,
  __setMpingoMetadataCacheForTest,
} from '../src/lib/mpingoPlayerMetadata.js'

const req = {
  protocol: 'https',
  get: (h) => (h === 'host' ? 'osmani-admin-api.onrender.com' : ''),
  headers: {},
}

process.env.STREAM_DELIVERY_MODE = 'hybrid'
process.env.DIRECT_STREAM_SIGNING_ENABLED = '1'
process.env.DIRECT_STREAM_SIGNING_SECRET = 'test-secret-min-16-chars!!'
process.env.BASE_URL = 'https://osmani-admin-api.onrender.com'

const ch1Url = 'https://nur.mpingotv.com/v3/player.php?channel=1'
const ch2Url = 'https://nur.mpingotv.com/v3/player.php?channel=2'

__clearMpingoMetadataCacheForTest()
__setMpingoMetadataCacheForTest(ch1Url, {
  streamUrl: 'https://cdnblncr.azamtvltd.co.tz/live/eds/AzamSport1/DASH/AzamSport1.mpd',
  clearKey: 'c31df1600afc33799ecac543331803f2:dd2101530e222f545997d4c553787f85',
  streamType: 'mpd',
  hasStreamUrl: true,
  hasClearKey: true,
  needsChromePlayer: false,
})

__setMpingoMetadataCacheForTest(ch2Url, {
  streamUrl: 'https://cdnblncr.azamtvltd.co.tz/live/eds/AzamSport2/DASH/AzamSport2.mpd',
  clearKey: '',
  streamType: 'mpd',
  hasStreamUrl: true,
  hasClearKey: false,
  needsChromePlayer: true,
})

const clearKeyChannel = channelToResponse(
  {
    id: 1,
    name: 'Azam 1 HD',
    url: ch1Url,
    playerType: 'webview',
    isActive: true,
    showInApp: true,
    category: 'General',
    bottomTab: 'Home',
    sortOrder: 1,
  },
  req,
)

assert.equal(clearKeyChannel.player_type_configured, 'webview')
assert.equal(clearKeyChannel.playerType, 'webview', 'ClearKey Mpingo stays webview')
assert.equal(clearKeyChannel.playbackUrl, ch1Url)
assert.equal(clearKeyChannel.playback_source, 'upstream')
assert.equal(clearKeyChannel.mpingo_drm?.has_clear_key, true)

const widevineChannel = channelToResponse(
  {
    id: 11,
    name: 'Azam TWO',
    url: ch2Url,
    playerType: 'webview',
    isActive: true,
    showInApp: true,
    category: 'General',
    bottomTab: 'Home',
    sortOrder: 2,
  },
  req,
)

assert.equal(widevineChannel.player_type_configured, 'webview')
assert.equal(widevineChannel.playerType, 'chrome', 'Widevine-only Mpingo must use chrome player')
assert.equal(widevineChannel.player_type, 'chrome', 'player_type alias')
assert.equal(widevineChannel.use_chrome_player, true, 'use_chrome_player flag')
assert.equal(widevineChannel.playbackUrl, ch2Url)
assert.equal(widevineChannel.playback_source, 'mpingo_chrome_widevine')
assert.equal(widevineChannel.mpingo_drm?.has_clear_key, false)

__clearMpingoMetadataCacheForTest()
console.log('test-mpingo-chrome-routing: OK')
