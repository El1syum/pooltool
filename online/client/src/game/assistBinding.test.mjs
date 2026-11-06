import assert from 'node:assert/strict'
import test from 'node:test'
import { bindingLabel, DEFAULT_ASSIST_BINDING, findBindingConflicts, isAssistKeyboardBinding, matchesAssistBinding, normalizeAssistBinding } from './assistBinding.ts'

test('legacy/missing/invalid assist bindings default to Ctrl, never hidden Alt', () => {
  assert.equal(DEFAULT_ASSIST_BINDING, 'ControlLeft')
  for (const value of [undefined, null, '', 'Mouse0', 'Mouse2', 'Escape', 'Unidentified', 7, {}]) {
    assert.equal(normalizeAssistBinding(value), 'ControlLeft')
    assert.equal(isAssistKeyboardBinding(value), false)
  }
  assert.equal(normalizeAssistBinding('KeyH'), 'KeyH')
})

test('modifier assist bindings accept either side of the configured family', () => {
  for (const family of ['Control', 'Alt', 'Shift', 'Meta']) {
    for (const configured of [`${family}Left`, `${family}Right`]) {
      assert.ok(matchesAssistBinding(`${family}Left`, configured))
      assert.ok(matchesAssistBinding(`${family}Right`, configured))
      assert.equal(matchesAssistBinding('KeyH', configured), false)
    }
  }
  assert.equal(matchesAssistBinding('AltLeft', undefined), false)
  assert.equal(matchesAssistBinding('ControlRight', undefined), true)
  assert.equal(matchesAssistBinding('KeyH', 'KeyH'), true)
  assert.equal(matchesAssistBinding('KeyJ', 'KeyH'), false)
})

test('visible labels match current bindings without exposing event-code names', () => {
  for (const [code, label] of [['ControlLeft', 'Ctrl'], ['ControlRight', 'Ctrl'], ['AltLeft', 'Alt'], ['ShiftRight', 'Shift'], ['MetaLeft', 'Meta'], ['KeyH', 'H'], ['Space', 'Пробел'], ['Mouse2', 'ПКМ']]) {
    assert.equal(bindingLabel(code), label)
  }
})

test('binding conflicts detect both literal keys and modifier-family overlaps', () => {
  assert.deepEqual(findBindingConflicts({ assist: 'ControlLeft', shoot: 'ControlRight' }), [['shoot', 'assist', 'Ctrl']])
  assert.deepEqual(findBindingConflicts({ assist: 'KeyH', shoot: 'KeyH' }), [['shoot', 'assist', 'H']])
  assert.deepEqual(findBindingConflicts({ assist: 'ControlLeft', shoot: 'Space', orbit: 'Mouse2' }), [])
})

test('a letter assist binding never steals Ctrl/Meta copy and paste chords', () => {
  for (const modifiers of [{ ctrlKey: true }, { metaKey: true }]) {
    assert.equal(matchesAssistBinding('KeyC', 'KeyC', modifiers), false)
    assert.equal(matchesAssistBinding('KeyV', 'KeyV', modifiers), false)
    assert.equal(matchesAssistBinding('KeyH', 'KeyH', modifiers), false)
  }
  assert.equal(matchesAssistBinding('KeyC', 'KeyC'), true)
  assert.equal(matchesAssistBinding('ControlRight', 'ControlLeft', { ctrlKey: true }), true)
})
