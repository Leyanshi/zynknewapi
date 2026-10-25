import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupSnapshot, groupChanges } from './groups.mjs'

test('reports ratio changes, deleted groups and changed remarks', () => {
  const before = groupSnapshot([
    { key: 'GroupRatio', value: '{"vip":1,"old":2}' },
    { key: 'UserUsableGroups', value: '{"vip":"旧备注"}' },
  ])
  const after = groupSnapshot([
    { key: 'GroupRatio', value: '{"vip":0.5}' },
    { key: 'UserUsableGroups', value: '{"vip":"新备注"}' },
  ])
  const text = groupChanges(before, after).join('\n')
  assert.match(text, /vip 调用倍率：1 → 0.5/)
  assert.match(text, /删除：old/)
  assert.match(text, /vip 备注：旧备注 → 新备注/)
  assert.deepEqual(groupChanges(after, after), [])
})

test('supports nested special ratios and bounded Unicode messages', () => {
  const before = groupSnapshot([{ key: 'GroupGroupRatio', value: '{"vip":{"default":1}}' }])
  const after = groupSnapshot([{ key: 'GroupGroupRatio', value: '{"vip":{"default":0}}' }])
  assert.match(groupChanges(before, after)[0], /vip → default 专属调用倍率：1 → 0/)
  const chunks = groupChanges({}, groupSnapshot([{ key: 'UserUsableGroups', value: JSON.stringify({ vip: '😀'.repeat(3000) }) }]))
  assert.ok(chunks.length > 1)
  assert.ok(chunks.every(chunk => Array.from(chunk).length <= 1210))
  assert.throws(() => groupSnapshot([{ key: 'GroupRatio', value: 'null' }]))
})

test('stale hierarchical aliases do not conceal updates made by the group editor', () => {
  const options = [
    { key: 'GroupRatio', value: '{"vip":0.5}' },
    { key: 'group_ratio_setting.group_ratio', value: '{"vip":1}' },
  ]
  const expected = groupSnapshot([options[0]])
  assert.deepEqual(groupSnapshot(options), expected)
  assert.deepEqual(groupSnapshot(options.toReversed()), expected)
})
