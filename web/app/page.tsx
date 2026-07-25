'use client'

import { useEffect, useState } from 'react'
import AuthGate from '@/components/AuthGate'
import Capture from '@/components/Capture'
import Digest from '@/components/Digest'
import Library from '@/components/Library'
import Write from '@/components/Write'
import { appOpen } from '@/lib/events'
import { supabase } from '@/lib/supabase'

/**
 * 앱 셸 — MVP 의 4개 화면 (docs/MVP.md §1.1).
 *
 * 라우터 대신 상태 하나로 전환한다. 화면 4개에 URL 이 필요 없고,
 * 새 탭으로 열 일도 없다.
 */
const SCREENS = [
  { id: 'capture', label: 'Capture' },
  { id: 'digest', label: 'Digest' },
  { id: 'library', label: 'Library' },
  { id: 'write', label: 'Write' },
] as const

type ScreenId = (typeof SCREENS)[number]['id']

export default function Page() {
  return (
    <AuthGate>
      <Shell />
    </AuthGate>
  )
}

function Shell() {
  const [screen, setScreen] = useState<ScreenId>('capture')
  const [pending, setPending] = useState<number | null>(null)

  // ★ 계측 + 고아 복구 (§2.2, §4.1). 로그인 직후 정확히 한 번.
  useEffect(() => {
    void appOpen().then(setPending)
  }, [])

  return (
    <div className="min-h-screen">
      <header className="border-b border-stone-200 bg-white">
        <nav className="mx-auto flex max-w-2xl items-center gap-1 px-6">
          <span className="mr-4 py-3 text-sm font-semibold tracking-tight text-stone-900">
            mintAI
          </span>
          {SCREENS.map((s) => (
            <button
              key={s.id}
              onClick={() => setScreen(s.id)}
              className={
                'relative border-b-2 px-3 py-3 text-sm transition-colors ' +
                (screen === s.id
                  ? 'border-stone-800 text-stone-900'
                  : 'border-transparent text-stone-400 hover:text-stone-600')
              }
            >
              {s.label}
              {s.id === 'digest' && !!pending && (
                <span className="ml-1.5 rounded-full bg-amber-100 px-1.5 text-xs text-amber-800">
                  {pending}
                </span>
              )}
            </button>
          ))}
          <button
            onClick={() => void supabase.auth.signOut()}
            className="ml-auto py-3 text-xs text-stone-300 hover:text-stone-500"
          >
            로그아웃
          </button>
        </nav>
      </header>

      <main>
        {screen === 'capture' ? (
          <Capture />
        ) : screen === 'digest' ? (
          <Digest />
        ) : screen === 'library' ? (
          <Library />
        ) : (
          <Write />
        )}
      </main>
    </div>
  )
}
