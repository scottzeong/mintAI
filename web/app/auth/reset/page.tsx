'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { MIN_PASSWORD, updatePassword } from '@/lib/auth'

/**
 * 비밀번호 재설정 착지점 (docs/AUTH.md §2)
 *
 * ⚠ 이 화면이 **별도 라우트**여야 하는 이유:
 *   앱 본체는 AuthGate 가 감싸고 있어서 로그인 전에는 아무것도 못 본다. 그런데
 *   재설정 링크로 들어온 사람은 "로그인한 것도 안 한 것도 아닌" 복구 세션 상태다.
 *   같은 화면에 두면 게이트에 막혀 비밀번호를 바꿀 수가 없다.
 *
 * 메일 링크는 `?code=...` 로 돌아오고, 브라우저 클라이언트가 이를 자동으로 세션과
 * 교환한다. 그 교환이 끝날 때까지 기다렸다가 입력란을 연다.
 */
export default function ResetPasswordPage() {
  const [ready, setReady] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  useEffect(() => {
    let settled = false

    const accept = () => {
      if (settled) return
      settled = true
      setReady(true)
    }

    // 이미 교환이 끝났을 수도 있고
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) accept()
    })

    // 아직이면 이벤트로 온다 (PASSWORD_RECOVERY / SIGNED_IN)
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      if (s) accept()
    })

    // 링크가 만료됐거나 이미 쓴 경우 — 세션이 영영 안 온다
    const timer = setTimeout(() => {
      if (!settled) setInvalid(true)
    }, 4000)

    return () => {
      sub.subscription.unsubscribe()
      clearTimeout(timer)
    }
  }, [])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (password !== confirm) {
      setError('두 비밀번호가 서로 다릅니다.')
      return
    }
    setBusy(true)
    setError(null)
    const r = await updatePassword(password)
    setBusy(false)
    if (!r.ok) {
      setError(r.message)
      return
    }
    setDone(true)
  }

  if (done) {
    return (
      <Shell>
        <p className="rounded-lg bg-mint-50 p-3 text-sm text-mint-700">
          비밀번호를 변경했습니다.
        </p>
        <a
          href="/"
          className="mt-4 block rounded-lg bg-mint-800 py-2.5 text-center text-sm text-white"
        >
          시작하기
        </a>
      </Shell>
    )
  }

  if (invalid) {
    return (
      <Shell>
        <p className="text-sm text-mint-600">
          링크가 만료되었거나 이미 사용되었습니다.
        </p>
        <p className="mt-2 text-xs text-mint-400">
          재설정 메일은 한 번만 쓸 수 있고 시간이 지나면 만료됩니다. 다시 요청해 주세요.
        </p>
        <a
          href="/"
          className="mt-4 block rounded-lg border border-mint-300 py-2.5 text-center
                     text-sm text-mint-700"
        >
          로그인 화면으로
        </a>
      </Shell>
    )
  }

  if (!ready) {
    return (
      <Shell>
        <p className="text-sm text-mint-400">확인 중…</p>
      </Shell>
    )
  }

  return (
    <Shell>
      <form onSubmit={submit} className="space-y-3">
        <input
          type="password"
          required
          minLength={MIN_PASSWORD}
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="새 비밀번호"
          className="w-full rounded-lg border border-mint-300 bg-white px-4 py-2.5 text-sm"
        />
        <input
          type="password"
          required
          minLength={MIN_PASSWORD}
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="새 비밀번호 확인"
          className="w-full rounded-lg border border-mint-300 bg-white px-4 py-2.5 text-sm"
        />
        <p className="text-xs text-mint-400">{MIN_PASSWORD}자 이상. 길수록 안전합니다.</p>

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-mint-800 py-2.5 text-sm text-white
                     disabled:bg-mint-200 disabled:text-mint-500"
        >
          {busy ? '변경 중…' : '비밀번호 변경'}
        </button>
      </form>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-sm px-6 py-20">
      <h1 className="text-lg font-semibold tracking-tight text-mint-600">mintAI</h1>
      <h2 className="mb-4 mt-8 text-sm font-medium text-mint-800">비밀번호 재설정</h2>
      {children}
    </div>
  )
}
