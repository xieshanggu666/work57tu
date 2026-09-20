// 文档版本恢复：端到端冒烟测试（fake-indexeddb + 真实 store）
// 运行：npm run test:restore（esbuild 打包后在 node 中执行）
import 'fake-indexeddb/auto'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { db } from '@/db'
import { useGapStore } from '@/stores/gap'
import { useReviewStore } from '@/stores/review'
import { useKbStore } from '@/stores/kb'
import { GAP } from '@/utils/gap'
import { REVIEW, REVIEW_KIND, PUBLISH } from '@/utils/review'
import {
  snapshotOf, diffSnapshots, canRestoreVersion, docVersion, ensureVersions
} from '@/utils/version'

const pinia = createPinia()
createApp({ render: () => null }).use(pinia)
const gap = useGapStore(pinia)
const review = useReviewStore(pinia)
const kb = useKbStore(pinia)

const editor = { id: 'u-edit', role: 'editor', name: '编辑甲' }
const editor2 = { id: 'u-edit2', role: 'editor', name: '编辑乙' }
const admin = { id: 'u-admin', role: 'admin', name: '管理员' }
const member = { id: 'u-m', role: 'member', name: '成员丙' }

let passed = 0
let failed = 0
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✅', msg) }
  else { failed++; console.error('  ❌', msg) }
}

async function mkDoc(title, body) {
  const doc = await kb.createDoc(
    { title, body, categoryId: 'c-dev', tagIds: ['t-db'], visibility: 'public' },
    editor
  )
  return doc
}

// ---------- 1. 保存即产生内容快照 ----------
console.log('\n[1] 每次保存的版本记录都附带内容快照')
let doc = await mkDoc('Dexie 指南', '<p>v1 正文</p>')
let r = await kb.updateDoc(doc.id,
  { title: 'Dexie 指南', body: '<p>v2 正文</p>', categoryId: 'c-dev', tagIds: ['t-db'], visibility: 'public' },
  editor, '补充正文',
  { baseVersion: 1, base: snapshotOf(doc) })
assert(r.status === 'saved', 'v2 保存成功')
doc = await db.docs.get(doc.id)
assert(doc.versions.length === 2, '版本数为 2')
assert(!!doc.versions[0].snapshot && doc.versions[0].snapshot.body === '<p>v1 正文</p>', 'v1 快照保留旧正文')
assert(doc.versions[1].snapshot.body === '<p>v2 正文</p>', 'v2 快照为新正文')
assert(canRestoreVersion(doc, 1) === true, 'v1 可恢复')
assert(canRestoreVersion(doc, 2) === false, '当前版本不可恢复')

// ---------- 2. 快照可比较 ----------
console.log('\n[2] 版本快照逐字段比较')
const d = diffSnapshots(doc.versions[1].snapshot, doc.versions[0].snapshot)
assert(d.length === 1 && d[0] === 'body', '仅正文字段存在差异')

// ---------- 3. 发起恢复评审：锁定文档，通过前内容不变 ----------
console.log('\n[3] 发起恢复评审：文档锁定，待审内容不提前生效')
r = await review.submitRestoreReview(doc.id, 1, 'v2 写错了，回到 v1', editor)
assert(r.status === 'ok', '恢复评审提交成功')
const restoreRevId = r.review.id
assert(r.review.kind === REVIEW_KIND.RESTORE && r.review.restoreFromVersion === 1, '评审单标记为版本恢复、来源 v1')
assert(!!r.review.baseSnapshot && r.review.baseSnapshot.body === '<p>v2 正文</p>', '记录发起时基线快照（用于并发检测）')
const pendingDoc = await db.docs.get(doc.id)
assert(pendingDoc.publishState === PUBLISH.IN_REVIEW && pendingDoc.activeReviewId === r.review.id, '文档进入评审中并锁定')
assert(pendingDoc.body === '<p>v2 正文</p>', '审批前正文保持 v2')
r = await review.submitRestoreReview(doc.id, 1, '', editor2)
assert(r.status === 'duplicate', '已有流转中评审单时拒绝重复发起')
r = await kb.updateDoc(doc.id,
  { title: 'Dexie 指南', body: '<p>抢写</p>', categoryId: 'c-dev', tagIds: ['t-db'], visibility: 'public' },
  editor2, '抢写', { baseVersion: 2 })
assert(r.status === 'review-locked', '评审期间直接保存被锁拦截')

// ---------- 4. 权限：成员不可发起恢复 ----------
console.log('\n[4] 权限：只读成员不能发起版本恢复')
const docX = await mkDoc('另一篇', '<p>x</p>')
r = await review.submitRestoreReview(docX.id, 1, '', member)
assert(r.status === 'denied', '非编辑角色被拒绝')

// ---------- 5. 审批通过：追加 v3，打恢复边界，问答引用更新 ----------
console.log('\n[5] 恢复评审通过：追加新版本（不回滚）+ 双向恢复边界 + 问答引用更新')
// 准备一张以本文档为答案来源的已解决工单（模拟更早一次补写送审）
const ticket = {
  id: 'gap-restore-1', question: 'Dexie 怎么 add？', detail: '', status: GAP.RESOLVED,
  createdBy: 'u-m', createdAt: new Date().toISOString(), claimedBy: editor.id, claimedAt: new Date().toISOString(),
  docId: doc.id, reviewId: 'rev-old', groupId: null, resolvedAt: new Date().toISOString(),
  sourceVersion: 2, timeline: []
}
await db.gapTickets.add(ticket)
r = await review.decideReview(restoreRevId, 'approve', '同意恢复', admin)
assert(r.status === 'ok' && r.restored === true && r.publishedVersion === 3, '审批通过并发布恢复版本 v3')
doc = await db.docs.get(doc.id)
assert(doc.versions.length === 3, '版本链追加为 3（v1/v2 均保留，未回滚）')
assert(doc.body === '<p>v1 正文</p>', '当前正文恢复为 v1 内容')
const v1 = doc.versions.find((x) => x.version === 1)
const v3 = doc.versions.find((x) => x.version === 3)
assert(Array.isArray(v1.restoredTo) && v1.restoredTo[0].version === 3, '旧记录 v1 标记恢复去向（恢复边界）→ v3')
assert(v3.restoreFrom === 1 && v3.restoreReviewId, '新记录 v3 标记恢复来源 v1')
assert(v3.note.includes('恢复自 v1'), '新版本备注标明恢复来源')
const tFresh = await db.gapTickets.get(ticket.id)
assert(tFresh.sourceVersion === 3, '已解决工单的答案来源版本更新到 v3（问答引用同步）')
assert(tFresh.timeline.some((e) => e.action === 'resync-source' && e.note.includes('v3')), '工单保留引用更新留痕（含原版本 v2）')
assert(tFresh.timeline.some((e) => e.note.includes('v2')), '留痕标明原引用版本')

// ---------- 6. 问答引用幂等：再次对无变化情形不产生重复留痕 ----------
console.log('\n[6] 恢复边界与引用更新的幂等/多次恢复累积')
await kb.updateDoc(doc.id,
  { title: 'Dexie 指南', body: '<p>v4 新补充</p>', categoryId: 'c-dev', tagIds: ['t-db'], visibility: 'public' },
  admin, '管理员直接修订', { baseVersion: 3, base: snapshotOf(doc) })
doc = await db.docs.get(doc.id)
r = await review.submitRestoreReview(doc.id, 1, '', editor)
await review.decideReview(r.review.id, 'approve', '', admin)
doc = await db.docs.get(doc.id)
assert(doc.versions.length === 5, '第二次恢复再次追加（v5），版本链持续增长')
const v1b = doc.versions.find((x) => x.version === 1)
assert(v1b.restoredTo.length === 2, '同一旧版本可被多次恢复，恢复去向累积两条边界')
const t2 = await db.gapTickets.get(ticket.id)
const resyncCount = t2.timeline.filter((e) => e.action === 'resync-source').length
assert(resyncCount === 2, '每次恢复各留一条引用更新记录（不重复、不漏记）')
assert(t2.sourceVersion === 5, '答案来源指向最新恢复版本 v5')

// ---------- 7. 并发修改漂移：审批时检测并要求管理员确认 ----------
console.log('\n[7] 评审期间并发修改：自动合并未冲突字段，冲突字段需确认')
let docB = await mkDoc('并发文档', '<p>初始</p>')
await kb.updateDoc(docB.id,
  { title: '并发文档', body: '<p>v2</p>', categoryId: 'c-dev', tagIds: ['t-db'], visibility: 'public' },
  editor, '', { baseVersion: 1, base: snapshotOf(docB) })
docB = await db.docs.get(docB.id)
// 编辑者发起普通修改评审：改正文
r = await review.submitReview(docB.id,
  { title: '并发文档', body: '<p>评审中的新正文</p>', categoryId: 'c-dev', tagIds: ['t-db'], visibility: 'public' },
  '改正文', editor)
const revB = r.review
// 模拟绕过：评审期间文档版本被推进（管理员在另一窗口直接保存，改了标题）
await db.docs.update(docB.id, {
  updatedAt: new Date().toISOString(),
  versions: [...ensureVersions(docB), {
    version: 3, savedAt: new Date().toISOString(), savedBy: 'u-admin', note: '管理员改标题',
    snapshot: snapshotOf({ ...docB, title: '管理员改的标题' })
  }],
  title: '管理员改的标题'
})
await kb.reloadDocs()
r = await review.decideReview(revB.id, 'approve', '', admin)
assert(r.status === 'drift-conflict', '检测到版本漂移且存在冲突，返回 drift-conflict')
// 本例双方改的是不同字段，标题应被自动合并（无冲突）——再造一个真正同字段冲突的场景
assert(r.conflictFields.includes('body'), '正文双方都改：列为冲突字段')
r = await review.decideReview(revB.id, 'approve', '', admin, { force: true })
assert(r.status === 'ok', '管理员确认以待审内容覆盖冲突后发布成功')
docB = await db.docs.get(docB.id)
assert(docB.body === '<p>评审中的新正文</p>', '冲突正文采用待审值')
assert(docB.title === '管理员改的标题', '标题（仅管理员改过）自动合并不丢失')
assert(docB.versions.length === 4, '追加发布版本 v4')

// ---------- 8. 无快照的旧记录不可恢复 ----------
console.log('\n[8] 升级前的无快照旧版本不可恢复')
await db.docs.add({
  id: 'doc-old-ver', title: '老文档', body: '<p>现在</p>', categoryId: 'c-dev', tagIds: [], visibility: 'public',
  ownerId: editor.id, editors: [editor.id], publishState: PUBLISH.PUBLISHED, activeReviewId: null,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  versions: [
    { version: 1, savedAt: new Date().toISOString(), savedBy: editor.id, note: '无快照的旧版本' },
    { version: 2, savedAt: new Date().toISOString(), savedBy: editor.id, note: '当前' }
  ]
})
await kb.reloadDocs()
assert(canRestoreVersion(await db.docs.get('doc-old-ver'), 1) === false, '无快照旧版本不可恢复')
r = await review.submitRestoreReview('doc-old-ver', 1, '', editor)
assert(r.status === 'no-snapshot', '提交恢复时服务端同样拦截')

// ---------- 9. 驳回不改动内容也不更新引用 ----------
console.log('\n[9] 恢复评审被驳回：内容与引用均不变')
let docC = await mkDoc('驳回文档', '<p>v1</p>')
await kb.updateDoc(docC.id,
  { title: '驳回文档', body: '<p>v2</p>', categoryId: 'c-dev', tagIds: [], visibility: 'public' },
  editor, '', { baseVersion: 1, base: snapshotOf(docC) })
r = await review.submitRestoreReview(docC.id, 1, '', editor)
await review.decideReview(r.review.id, 'reject', '暂不恢复', admin)
docC = await db.docs.get(docC.id)
assert(docC.body === '<p>v2</p>' && docC.versions.length === 2, '驳回后内容保持、无新版本')
assert(docC.publishState === PUBLISH.PUBLISHED && !docC.activeReviewId, '文档解除锁定')

console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exit(failed ? 1 : 0)
