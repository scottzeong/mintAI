/**
 * 시각 표시 유틸.
 *
 * Postgres 의 timestamptz 는 ISO-8601 에 오프셋을 포함해 돌려주므로
 * SQLite 판에서 겪었던 "타임존 없는 UTC 문자열" 함정은 사라졌다.
 * 다만 방어적으로 오프셋이 없는 문자열도 UTC 로 간주한다.
 */
export function parseServerTime(s: string): Date {
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) return new Date(s)
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
