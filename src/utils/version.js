// 文档版本与并发保存：版本号读取、旧数据兼容、三方字段合并
// 供 kb store 的乐观锁冲突检测使用，均为纯函数便于测试

// 当前版本号。旧数据没有 versions 字段时视为 1 个版本（与 ensureVersions 的补全逻辑一致）
export function docVersion(doc) {
  if (!doc) return 0
  return Array.isArray(doc.versions) && doc.versions.length ? doc.versions.length : 1
}

// 兼容已有文档：缺失/损坏的 versions 记录补一条初始版本，保证后续追加不丢历史
export function ensureVersions(doc, now) {
  if (Array.isArray(doc.versions) && doc.versions.length) return doc.versions
  return [{
    version: 1,
    savedAt: doc.createdAt || doc.updatedAt || now,
    savedBy: doc.ownerId || 'u-guest',
    note: '初始版本'
  }]
}

function sameVal(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

// 三方合并：以 base（编辑器打开时的快照）为基准，把 patch 合并到 latest（库中最新）上
// - latest 相对 base 未变的字段：采用我方 patch 值
// - 我方相对 base 未变的字段：保留 latest（对方）值
// - 双方都改了同一字段：记入 conflicts，由调用方决定（默认保留 latest，等待用户选择）
// 返回 { fields, autoMerged, conflicts }
export function mergeDocFields(latest, base, patch) {
  const fields = {}
  const autoMerged = []
  const conflicts = []
  for (const key of Object.keys(patch)) {
    const mine = patch[key]
    const theirs = latest?.[key]
    const origin = base?.[key]
    const otherChanged = !sameVal(theirs, origin)
    const mineChanged = !sameVal(mine, origin)
    if (!otherChanged || !mineChanged) {
      // 只有一方改过（或都没改）：安全取值；双方都改时才可能冲突
      fields[key] = mineChanged ? mine : theirs
      if (otherChanged && !mineChanged) autoMerged.push(key)
    } else if (sameVal(mine, theirs)) {
      fields[key] = mine // 双方改成一样的值，不算冲突
    } else {
      conflicts.push(key)
      fields[key] = theirs // 冲突字段先保留库中最新，等待用户决策
    }
  }
  return { fields, autoMerged, conflicts }
}

// 可编辑字段的中文名，用于冲突提示
export const DOC_FIELD_LABELS = {
  title: '标题', categoryId: '分类', tagIds: '标签', visibility: '可见性', body: '正文'
}

export function fieldLabels(keys) {
  return (keys || []).map((k) => DOC_FIELD_LABELS[k] || k)
}
