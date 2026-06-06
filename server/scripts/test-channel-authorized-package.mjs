import {
  normalizeAuthorizedPackageName,
  validateAuthorizedPackageName,
} from '../src/lib/channelAuthorizedPackage.js'

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

assert(normalizeAuthorizedPackageName('  MWENZI 1  ') === 'MWENZI 1', 'trim + collapse')
assert(normalizeAuthorizedPackageName('') === '', 'empty')
assert(validateAuthorizedPackageName('') === null, 'empty ok')
assert(validateAuthorizedPackageName('MWAKA') === null, 'simple name ok')
assert(validateAuthorizedPackageName('Wiki-1 (7d)') === null, 'punctuation ok')
assert(validateAuthorizedPackageName('bad<>name') != null, 'reject angle brackets')

console.log('All channel authorized package validation tests passed.')
