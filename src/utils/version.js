// 文档版本、内容快照与并发保存：快照读写、版本比较（diff）、恢复边界、三方字段合并
// 供 kb / review store 使用，均为纯函数便于测试

// 进入版本快照的字段：恢复历史版本时只回放这些内容字段，
// 可见性属于内容发布范围一并回放；owner/editors/评论/授权等管理字段永不随恢复变动
export const SNAPSHOT_FIELDS = ['title', 'body', 'categoryId', 'tagIds', 'visibility']

// 从文档/补丁中提取一份内容快照（拷贝，避免外部数组后续变更污染版本记录）
export function snapshotOf(source = {}) {
  return {
    title: source.title ?? '',
    body: source.body ?? '',
    categoryId: source.categoryId ?? null,
    tagIds: Array.isArray(source.tagIds) ? [...source.tagIds] : [],
    visibility: source.visibility ?? 'public'
  }
}

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
    note: '初始版本',
    snapshot: snapshotOf(doc)
  }]
}

// 历史版本自身可能没有快照（升级前产生的旧记录）。
// 若恰好是最新版本，可用文档当前内容补全展示与比较；更早的版本无内容可还原，只能看元信息
export function versionSnapshot(doc, v) {
  if (!v) return null
  if (v.snapshot) return v.snapshot
  if (doc && v.version === docVersion(doc)) return snapshotOf(doc)
  return null
}

// 按版本号取版本记录
export function findVersion(doc, n) {
  const versions = doc ? ensureVersions(doc) : []
  return versions.find((v) => v.version === n) || null
}

// 历史版本是否可用于恢复：必须是带内容快照的非当前版本（当前版本恢复无意义）
export function canRestoreVersion(doc, n) {
  const v = findVersion(doc, n)
  if (!v || !v.snapshot) return false
  return v.version < docVersion(doc)
}

function sameVal(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

// 两个快照之间发生变化的字段名
export function diffSnapshots(from, to) {
  const a = snapshotOf(from || {})
  const b = snapshotOf(to || {})
  return SNAPSHOT_FIELDS.filter((k) => !sameVal(a[k], b[k]))
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

// 可编辑字段的中文名，用于冲突与差异提示
export const DOC_FIELD_LABELS = {
  title: '标题', categoryId: '分类', tagIds: '标签', visibility: '可见性', body: '正文'
}

export function fieldLabels(keys) {
  return (keys || []).map((k) => DOC_FIELD_LABELS[k] || k)
}

// ---- 恢复边界 ----
// 新版本记录上的恢复来源：标记它由哪个历史版本经恢复评审生成
export function markRestoreSource(versionRecord, fromVersion, reviewId) {
  return { ...versionRecord, restoreFrom: fromVersion, restoreReviewId: reviewId || null }
}

// 旧版本记录上的恢复去向：该历史快照曾被恢复为哪个新版本（可多次恢复，按时间累积）
export function markRestoredTarget(versionRecord, toVersion, at, reviewId) {
  const links = Array.isArray(versionRecord.restoredTo) ? versionRecord.restoredTo : []
  return {
    ...versionRecord,
    restoredTo: [...links, { version: toVersion, at: at || null, reviewId: reviewId || null }]
  }
}

// 从版本列表中取出需要打「恢复边界」标记的旧记录（新数组，不原地改）
export function withRestoreBoundary(versions, fromVersion, toVersion, at, reviewId) {
  return versions.map((v) =>
    v.version === fromVersion ? markRestoredTarget(v, toVersion, at, reviewId) : v
  )
}
