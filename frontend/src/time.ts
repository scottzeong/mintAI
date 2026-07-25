/**
 * 시각 표시 유틸.
 *
 * ⚠ 함정: SQLite `datetime('now')` 는 **UTC** 를 `"2026-07-25 04:42:19"` 형태로 준다.
 * 타임존 표기가 없어서 `new Date(...)` 가 이걸 **로컬 시각으로** 해석한다.
 * 한국(UTC+9)에서는 방금 저장한 항목이 "9시간 전"으로 표시된다.
 * 그래서 파싱 전에 UTC 임을 명시해 준다.
 */
export function parseServerTime(s: string): Date {
  // 이미 타임존 정보가 있으면(낙관적 항목의 ISO 문자열) 그대로 둔다
  if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(s)) return new Date(s)
  return new Date(s.replace(' ', 'T') + 'Z')
}

export function relativeTime(s: string): string {
  const diffSec = (Date.now() - parseServerTime(s).getTime()) / 1000

  if (diffSec < 60) return '방금'
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}분 전`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}시간 전`
  if (diffSec < 86400 * 7) return `${Math.floor(diffSec / 86400)}일 전`

  return parseServerTime(s).toLocaleDateString('ko-KR', {
    month: 'numeric',
    day: 'numeric',
  })
}
