import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emptyProfileDetails, normalizeProfileDetails, profileRatingMilestone, sanitizeProfileField } from './profileDetails.ts'

test('private profile values do not replace or derive from the public nickname', () => {
  const values = { fullName: '  Олександр Коваль  ', city: ' Київ ', about: 'Два рядки\r\nпро гру', displayName: 'CueMaster', extra: 'discard' }
  assert.deepEqual(normalizeProfileDetails(values), { fullName: 'Олександр Коваль', city: 'Київ', about: 'Два рядки\nпро гру' })
  assert.deepEqual(normalizeProfileDetails({ displayName: 'CueMaster' }), emptyProfileDetails())
  for (const malformed of [null, undefined, [], '', true, 12]) assert.deepEqual(normalizeProfileDetails(malformed), emptyProfileDetails())
  assert.deepEqual(normalizeProfileDetails({ fullName: 100, city: [], about: {} }), emptyProfileDetails())
})

test('profile text removes invisible controls, preserves language joiners, and keeps biography multiline', () => {
  assert.equal(sanitizeProfileField('city', '\u202eКиі\u0308в\u2069\u0000\u200b\r\nцентр'), 'Київ центр')
  assert.equal(sanitizeProfileField('about', 'خط\u200cدوم\u2028👩\u200d🔧\u0007'), 'خط\u200cدوم\n👩\u200d🔧')
  assert.equal(sanitizeProfileField('about', '\ud800visible\udc00'), 'visible')
  assert.equal(sanitizeProfileField('city', ' Київ ', true), ' Київ ')
  assert.equal(sanitizeProfileField('city', ' Київ '), 'Київ')
})

test('profile fields enforce native UTF-16 limits without truncating an emoji in half', () => {
  assert.equal(sanitizeProfileField('fullName', 'і'.repeat(80)), 'і'.repeat(64))
  assert.equal(sanitizeProfileField('city', 'К'.repeat(63) + '🌻'), 'К'.repeat(63))
  assert.equal(sanitizeProfileField('about', '🎱'.repeat(151)), '🎱'.repeat(150))
})

test('rating progress uses the next numeric 100-Elo milestone, not league ranks', () => {
  assert.deepEqual(profileRatingMilestone(1240), { elo: 1240, start: 1200, target: 1300, remaining: 60, percent: 40 })
  assert.deepEqual(profileRatingMilestone(1000), { elo: 1000, start: 1000, target: 1100, remaining: 100, percent: 0 })
  assert.deepEqual(profileRatingMilestone(99), { elo: 99, start: 0, target: 100, remaining: 1, percent: 99 })
  for (const malformed of [-1, NaN, Infinity, 1000.5, Number.MAX_SAFE_INTEGER]) assert.equal(profileRatingMilestone(malformed), null)
})
