'use client'

import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'
import AuthShell from '@/components/AuthShell'
import { MIN_PASSWORD, requestPasswordReset, signIn, signUp } from '@/lib/auth'

type Mode = 'signin' | 'signup' | 'reset'

/**
 * 로그인 게이트 (docs/AUTH.md)
 *
 * ⚠ **"아이디 찾기"는 만들지 않는다** (AUTH.md §0).
 *   아이디가 곧 이메일이라 찾을 대상이 없고, "이 이메일이 가입돼 있나요"에 답하는
 *   화면은 회원 명부를 알려주는 창구가 된다.
 *
 * ⚠ 매직 링크 버튼을 화면에서 뺐다 (2026-07-25).
 *   기능 자체는 lib/auth.ts 에 남아 있다. 다만 매직 링크로만 가입한 기존 계정은
 *   비밀번호가 없으므로, **"비밀번호를 잊으셨나요"가 그들의 유일한 입구**다.
 *   그래서 그 링크는 반드시 눈에 띄는 자리에 둔다.
 */
export default function AuthGate({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)

  const [mode, setMode] = useState<Mode>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  function switchMode(next: Mode) {
    setMode(next)
    setError(null)
    setNotice(null)
    setPassword('')
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setNotice(null)

    const r =
      mode === 'signin'
        ? await signIn(email, password)
        : mode === 'signup'
          ? await signUp(email, password)
          : await requestPasswordReset(email)

    setBusy(false)
    if (!r.ok) setError(r.message)
    else if (r.message) setNotice(r.message)
    // 로그인 성공은 메시지가 없다 — onAuthStateChange 가 화면을 넘긴다
  }

  if (loading) {
    return (
      <AuthShell>
        <p className="text-center text-sm text-mint-400">불러오는 중…</p>
      </AuthShell>
    )
  }
  if (session) return <>{children}</>

  const title =
    mode === 'signin' ? '로그인' : mode === 'signup' ? '회원가입' : '비밀번호 재설정'

  return (
    <AuthShell>
      <h2 className="text-sm font-medium text-mint-800">{title}</h2>

      {mode === 'reset' && (
        <p className="mt-2 text-xs leading-relaxed text-mint-500">
          가입한 주소를 입력하면 재설정 링크를 보냅니다. 비밀번호를 아직 만들지 않았다면
          여기서 처음 설정할 수 있습니다.
        </p>
      )}

      <form onSubmit={submit} className="mt-4 space-y-3">
        <input
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="w-full rounded-lg border border-mint-300 bg-white px-4 py-2.5 text-sm"
        />

        {mode !== 'reset' && (
          <div>
            <input
              type="password"
              required
              minLength={MIN_PASSWORD}
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="비밀번호"
              className="w-full rounded-lg border border-mint-300 bg-white px-4 py-2.5 text-sm"
            />
            {mode === 'signup' && (
              /* 복잡도 규칙 대신 길이만 요구한다 — 특수문자 강제는
                 Password1! 같은 예측 가능한 비밀번호를 만든다 (AUTH.md §3) */
              <p className="mt-1.5 text-xs text-mint-400">
                {MIN_PASSWORD}자 이상. 길수록 안전합니다.
              </p>
            )}
          </div>
        )}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-mint-800 py-2.5 text-sm text-white
                     disabled:bg-mint-200 disabled:text-mint-500"
        >
          {busy
            ? '처리 중…'
            : mode === 'signin'
              ? '로그인'
              : mode === 'signup'
                ? '가입하기'
                : '재설정 메일 받기'}
        </button>
      </form>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      {notice && (
        <p className="mt-3 rounded-lg bg-mint-50 p-3 text-sm text-mint-700">{notice}</p>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-mint-500">
        {mode !== 'signin' && (
          <button onClick={() => switchMode('signin')} className="hover:text-mint-800">
            로그인으로
          </button>
        )}
        {mode !== 'signup' && (
          <button onClick={() => switchMode('signup')} className="hover:text-mint-800">
            회원가입
          </button>
        )}
        {mode !== 'reset' && (
          <button onClick={() => switchMode('reset')} className="hover:text-mint-800">
            비밀번호를 잊으셨나요
          </button>
        )}
      </div>
    </AuthShell>
  )
}
