'use client'

import { createBrowserClient } from '@supabase/ssr'

/**
 * 브라우저 Supabase 클라이언트.
 *
 * 모든 데이터 접근이 RLS 를 통과한다 (supabase/migrations/0001_init.sql).
 * anon 키는 공개되어도 안전하다 — 키가 권한을 주는 게 아니라 로그인 세션이 준다.
 * 미인증 상태에서는 auth.uid() 가 null 이고, 정책이 전부 false 가 되어 0행이 보인다.
 */
export const supabase = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
)
