// 权限工具：基于角色与文档可见性
import { isShareActive } from './share'
import { isDocInReview } from './review'
import { isGrantActive, ACCESS_PERM } from './access'

export const ROLE = { ADMIN: 'admin', EDITOR: 'editor', VIEWER: 'viewer' }

// 可新增/编辑/删除的（内容治理）
export function canEditContent(role) {
  return role === ROLE.ADMIN || role === ROLE.EDITOR
}

// 文档编辑者：拥有者 / 固定协作成员 / 持限时协作授权（collab）/ 公开可编辑
// pendingReview 非空表示该文档有流转中的评审单：评审中锁定编辑，仅管理员可继续直接改动。
// 限时协作授权是成员级例外：只读角色在授权期内也可编辑该文档，但同样受评审锁定约束。
export function canEditDoc(role, doc, userId, pendingReview, grant) {
  if (!doc) return false
  // 管理员不受评审锁定；其余人在评审中一律不能直接改（授权成员也不例外，审批通过后恢复）
  if (isDocInReview(doc, pendingReview) && role !== ROLE.ADMIN) return false
  if (doc.ownerId === userId) return true
  if (doc.editors && doc.editors.includes(userId)) return true
  // 限时协作授权：授权期内放开编辑（角色门靠后，使只读成员也能协作）
  if (isGrantActive(grant) && grant.grant?.permission === ACCESS_PERM.COLLAB) return true
  if (!canEditContent(role)) return false
  return false
}

// 是否可查看某文档（可见性 + 拥有者 + 协作成员 + 有效限时授权 + 有效共享链接）
// grant：该用户在该文档上的访问申请记录（approved 且未撤销/未到期才授权）
export function canViewDoc(doc, userId, share, grant, now) {
  if (!doc) return false
  if (doc.visibility === 'public') return true
  if (doc.visibility === 'team') {
    // team 指全员可见（演示简化：所有登录成员可见）
    return true
  }
  // private：拥有者、固定协作成员、限时授权成员可见（或持有效共享链接——已撤销/已过期不授权）
  if (doc.ownerId === userId) return true
  if (doc.editors && doc.editors.includes(userId)) return true
  if (isGrantActive(grant, now)) return true
  if (isShareActive(share)) return true
  return false
}

export function canDeleteDoc(role, doc, userId) {
  return canEditDoc(role, doc, userId)
}

export function roleLabel(role) {
  return { admin: '管理员', editor: '编辑者', viewer: '只读' }[role] || role
}
