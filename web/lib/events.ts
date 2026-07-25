'use client'

import { supabase } from './supabase'

/**
 * 계측 (docs/MVP.md §2.2).
 *
 * 실패해도 절대 throw 하지 않는다 — 측정 장치가 측정 대상 행동을 막으면 본말전도다.
 */
export async function logEvent(kind: string, meta?: string): Promise<void> {
  try {
    await supabase.from('events').insert({ kind, meta: meta ?? null })
  } catch {
    /* 무시 */
  }
}

/**
 * 앱 진입 — 계측 기록과 고아 복구를 DB 함수 하나로 처리한다 (§2.2, §4.1).
 * 반환값은 소화 대기 큐 길이.
 */
export async function appOpen(): Promise<number> {
  try {
    const { data } = await supabase.rpc('app_open')
    return typeof data === 'number' ? data : 0
  } catch {
    return 0
  }
}
