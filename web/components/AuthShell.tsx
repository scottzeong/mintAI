import Image from 'next/image'

/**
 * 로그인·재설정 화면의 공통 껍데기.
 *
 * 배경 사진 위에 흐린 판을 덮고 그 위에 내용을 얹는다. 사진을 그대로 두면
 * 입력란 글자가 사진의 밝은 부분에 묻힌다 — 배경은 분위기를 만드는 것이지
 * 읽기를 방해하면 안 된다.
 *
 * 배경은 1.6MB PNG 를 60KB WebP 로 줄여 쓴다. 로그인 화면은 **가장 먼저 보는
 * 화면**이라 여기서 느리면 서비스 전체가 느려 보인다.
 */
export default function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-screen">
      {/* 배경 */}
      <div
        aria-hidden
        className="fixed inset-0 -z-10 bg-cover bg-center"
        style={{ backgroundImage: "url('/login-bg.webp')" }}
      />
      {/* 가독성용 덮개 — 사진의 밝은 부분에서 글자가 묻히는 걸 막는다 */}
      <div aria-hidden className="fixed inset-0 -z-10 bg-mint-50/70 backdrop-blur-[2px]" />

      <div className="flex min-h-screen items-center justify-center px-6 py-16">
        <div className="w-full max-w-sm">
          {/* 로고 → 태그라인 → 박스 */}
          <div className="mb-6 text-center">
            <Image
              src="/logo.png"
              alt="mintAI"
              width={256}
              height={80}
              priority
              className="mx-auto h-11 w-auto"
            />
            <p className="mt-3 text-[13px] leading-relaxed text-mint-700">
              Powered by AI intelligence, Written by Human insight
            </p>
          </div>

          <div className="rounded-2xl border border-white/60 bg-white/85 p-7 shadow-sm backdrop-blur-sm">
            {children}
          </div>
        </div>
      </div>
    </div>
  )
}
