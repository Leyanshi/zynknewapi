const labels = {
  GroupRatio: '调用倍率',
  'group_ratio_setting.group_ratio': '调用倍率',
  GroupGroupRatio: '专属调用倍率',
  'group_ratio_setting.group_group_ratio': '专属调用倍率',
  UserUsableGroups: '备注',
}

export function groupSnapshot(options) {
  const snapshot = {}
  const keys = new Set(options.map(option => option.key))
  for (const { key, value } of options) {
    if (!(key in labels)) continue
    // The settings API can include legacy and hierarchical names together.
    // The current group editor writes the legacy names; stale aliases must
    // never overwrite their values based on API enumeration order.
    if (key === 'group_ratio_setting.group_ratio' && keys.has('GroupRatio')) continue
    if (key === 'group_ratio_setting.group_group_ratio' && keys.has('GroupGroupRatio')) continue
    const parsed = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid group settings')
    for (const [group, setting] of Object.entries(parsed)) {
      if (setting !== null && typeof setting === 'object' && !Array.isArray(setting)) {
        for (const [target, ratio] of Object.entries(setting)) {
          snapshot[JSON.stringify([labels[key], group, target])] = ratio
        }
      } else {
        snapshot[JSON.stringify([labels[key], group])] = setting
      }
    }
  }
  return snapshot
}

export function groupChanges(previous, current) {
  const lines = []
  for (const key of [...new Set([...Object.keys(previous), ...Object.keys(current)])].sort()) {
    if (previous[key] === current[key]) continue
    const [label, group, target] = JSON.parse(key)
    const name = target ? `${group} → ${target}` : group
    if (!(key in current)) lines.push(`删除：${name}（${label}，原值 ${previous[key]}）`)
    else if (!(key in previous)) lines.push(`新增：${name}（${label}：${current[key]}）`)
    else lines.push(`${name} ${label}：${previous[key]} → ${current[key]}`)
  }
  // Keep individual messages below the platform's text limit, even for long remarks.
  const text = lines.join('\n')
  const characters = Array.from(text)
  const chunks = []
  for (let index = 0; index < characters.length; index += 1200) {
    chunks.push('分组配置变更\n' + characters.slice(index, index + 1200).join(''))
  }
  return chunks
}
