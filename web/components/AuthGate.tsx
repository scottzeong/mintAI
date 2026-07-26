'use client'

import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'

/**
 * 매직 링크 로그인.
 *
 * 로컬 도구였을 때는 인증이 필요 없었다 (MVP.md 부록). 공개 URL 이 되는 순간
 * 필요해진다 — 미출간 저술 데이터가 주소만 알면 열리는 상태가 되기 때문이다.
 *
 * 비밀번호를 쓰지 않는 이유: 사용자가 한 명이고, 비밀번호는 재설정 흐름·해싱 정책·
 * 유출 대응까지 딸려온다. 매직 링크는 그 전부를 메일함으로 넘긴다.
 */
export default function AuthGate({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  async function sendLink(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: window.location.origin },
    })
    if (error) setError(error.message)
    else setSent(true)
  }

  if (loading) {
    return <div className="p-10 text-center text-sm text-mint-400">불러오는 중…</div>
  }

  if (!session) {
    return (
      <div className="mx-auto max-w-sm px-6 py-24">
        <h1 className="text-lg font-semibold tracking-tight text-mint-600">mintAI</h1>
        <p className="mt-1 text-sm text-mint-500">
          자신의 생각들을 키워나갈 수 있는 글쓰기 도구
        </p>

        {sent ? (
          <p className="mt-8 rounded-lg bg-mint-100 p-4 text-sm text-mint-600">
            <strong className="text-mint-800">{email}</strong> 로 로그인 링크를 보냈습니다.
            메일함을 확인하세요.
          </p>
        ) : (
          <form onSubmit={sendLink} className="mt-8">
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full rounded-lg border border-mint-300 bg-white px-4 py-2.5 text-sm"
            />
            <button
              type="submit"
              className="mt-3 w-full rounded-lg bg-mint-800 py-2.5 text-sm text-white"
            >
              로그인 링크 받기
            </button>
            {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
          </form>
        )}
      </div>
    )
  }

  return <>{children}</>
}
