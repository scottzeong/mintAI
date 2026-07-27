'use client'

import { supabase } from './supabase'

/**
 * 인증 (docs/AUTH.md)
 *
 * ⚠ 이 파일의 모든 함수는 **가입 여부를 절대 노출하지 않는다.**
 *   "이 이메일이 가입돼 있나요?"에 답하는 순간 회원 명부가 새어 나간다 (§0.2).
 *   그래서 성공·실패 메시지가 상황과 무관하게 동일하다.
 */

export const MIN_PASSWORD = 8

/** 재설정·확인 메일이 돌아올 주소. 접속한 도메인을 그대로 쓴다 */
const origin = () => (typeof window === 'undefined' ? '' : window.location.origin)

export interface AuthResult {
  ok: boolean
  message: string
}

/** Supabase 영문 오류를 사람이 읽을 한국어로. 모르는 건 원문을 남긴다 */
function toKorean(msg: string): string {
  const m = msg.toLowerCase()
  if (m.includes('invalid login credentials'))
    return '이메일 또는 비밀번호가 올바르지 않습니다.'
  if (m.includes('email not confirmed'))
    return '아직 이메일 확인이 끝나지 않았습니다. 받은 편지함의 확인 링크를 눌러주세요.'
  if (m.includes('password should be at least'))
    return `비밀번호는 ${MIN_PASSWORD}자 이상이어야 합니다.`
  if (m.includes('pwned') || m.includes('compromised'))
    return '이미 유출된 적이 있는 비밀번호입니다. 다른 비밀번호를 쓰세요.'
  if (m.includes('rate limit') || m.includes('too many'))
    return '요청이 너무 잦습니다. 잠시 후 다시 시도하세요.'
  if (m.includes('same password'))
    return '이전과 다른 비밀번호를 입력하세요.'
  return msg
}

function checkPassword(pw: string): string | null {
  if (pw.length < MIN_PASSWORD) return `비밀번호는 ${MIN_PASSWORD}자 이상이어야 합니다.`
  return null
}

// ─────────────────────────── 회원가입 ───────────────────────────

/**
 * ⚠ 이미 가입된 이메일이어도 **성공처럼 응답한다.**
 *
 *   Supabase 는 이 경우 user 를 돌려주되 `identities` 를 비운다. 그걸 보고
 *   "이미 가입된 이메일입니다"라고 알려주면 계정 열거가 된다.
 *   실제로 메일이 오는지 여부로만 알 수 있고, 그건 메일함 주인만 안다.
 */
export async function signUp(email: string, password: string): Promise<AuthResult> {
  const bad = checkPassword(password)
  if (bad) return { ok: false, message: bad }

  const { error } = await supabase.auth.signUp({
    email: email.trim(),
    password,
    options: { emailRedirectTo: origin() },
  })
  if (error) return { ok: false, message: toKorean(error.message) }

  return {
    ok: true,
    message: '확인 메일을 보냈습니다. 받은 편지함의 링크를 눌러 가입을 마쳐주세요.',
  }
}

// ─────────────────────────── 로그인 ───────────────────────────

export async function signIn(email: string, password: string): Promise<AuthResult> {
  const { error } = await supabase.auth.signInWithPassword({
    email: email.trim(),
    password,
  })
  if (error) return { ok: false, message: toKorean(error.message) }
  return { ok: true, message: '' }
}

/**
 * 매직 링크. 비밀번호를 잊었거나 아직 만들지 않은 사람의 통로다 (§0.3).
 * 비밀번호 로그인을 추가했다고 없애지 않는다.
 */
export async function signInWithMagicLink(email: string): Promise<AuthResult> {
  const { error } = await supabase.auth.signInWithOtp({
    email: email.trim(),
    options: { emailRedirectTo: origin() },
  })
  if (error) return { ok: false, message: toKorean(error.message) }
  return { ok: true, message: '로그인 링크를 보냈습니다. 받은 편지함을 확인하세요.' }
}

// ─────────────────────────── 비밀번호 재설정 ───────────────────────────

/**
 * ⚠ 가입 여부와 **무관하게 같은 문구**를 돌려준다 (§0.2).
 *
 *   가입 안 된 주소에 "가입 이력이 없습니다"라고 답하면, 그게 곧 회원 조회 도구다.
 *   매직 링크와 함께 이 함수가 사실상 "아이디 찾기"를 대신한다 —
 *   쓰던 주소로 요청해 보고, 메일이 오면 그 주소가 맞는 것이다.
 */
export async function requestPasswordReset(email: string): Promise<AuthResult> {
  const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
    redirectTo: `${origin()}/auth/reset`,
  })
  // 오류가 나도 같은 문구를 돌려준다. 단 요청 제한만은 알려준다 —
  // 그건 가입 여부가 아니라 내 행동에 대한 정보라서 새어 나갈 게 없다.
  if (error && /rate limit|too many/i.test(error.message)) {
    return { ok: false, message: toKorean(error.message) }
  }
  return {
    ok: true,
    message:
      '해당 주소로 가입된 계정이 있다면 재설정 메일이 갑니다. 받은 편지함을 확인하세요.',
  }
}

/** 재설정 링크로 들어온 뒤 새 비밀번호를 저장한다 */
export async function updatePassword(password: string): Promise<AuthResult> {
  const bad = checkPassword(password)
  if (bad) return { ok: false, message: bad }

  const { error } = await supabase.auth.updateUser({ password })
  if (error) return { ok: false, message: toKorean(error.message) }
  return { ok: true, message: '비밀번호를 변경했습니다.' }
}

export async function signOut() {
  await supabase.auth.signOut()
}
