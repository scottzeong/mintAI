import { useState } from 'react'
import Capture from './screens/Capture'
import Digest from './screens/Digest'

/**
 * 앱 셸 — MVP 의 4개 화면 (docs/MVP.md §1.1).
 *
 * Week 2 까지 Capture · Digest 구현. 나머지는 자리만 잡아 두되,
 * **언제 만들 것인지를 화면에 적어 둔다.** 빈 화면에 "준비 중"만 띄우면
 * 무엇이 남았는지 잊게 된다.
 *
 * 라우터를 안 쓰는 이유: 화면 4개에 URL 이 필요 없다. 의존성이 줄면
 * 설치 실패로 시작조차 못 하는 리스크가 준다 (§6).
 */
const SCREENS = [
  { id: 'capture', label: 'Capture', week: 1 },
  { id: 'digest', label: 'Digest', week: 2 },
  { id: 'library', label: 'Library', week: 3 },
  { id: 'write', label: 'Write', week: 3 },
] as const

type ScreenId = (typeof SCREENS)[number]['id']

export default function App() {
  const [screen, setScreen] = useState<ScreenId>('capture')
  const current = SCREENS.find((s) => s.id === screen)!

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
                'border-b-2 px-3 py-3 text-sm transition-colors ' +
                (screen === s.id
                  ? 'border-stone-800 text-stone-900'
                  : 'border-transparent text-stone-400 hover:text-stone-600')
              }
            >
              {s.label}
            </button>
          ))}
        </nav>
      </header>

      <main>
        {screen === 'capture' ? (
          <Capture />
        ) : screen === 'digest' ? (
          <Digest />
        ) : (
          <div className="mx-auto max-w-2xl px-6 py-20 text-center">
            <p className="text-stone-500">
              <strong className="text-stone-700">{current.label}</strong> — Week{' '}
              {current.week} 구현 예정
            </p>
            <p className="mt-2 text-sm text-stone-400">
              docs/MVP.md §7 개발 계획
            </p>
          </div>
        )}
      </main>
    </div>
  )
}
