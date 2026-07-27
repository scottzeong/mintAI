import type { Metadata, Viewport } from 'next'
import './globals.css'

export const metadata: Metadata = {
  // 탭에 보이는 이름. 브라우저 탭은 폭이 좁아 앞부분만 보이므로 짧게 둔다.
  title: 'mintAI',
  description: '자신의 생각들을 키워나갈 수 있는 글쓰기 도구',
  // 파비콘은 app/icon.png · app/apple-icon.png 를 Next.js 가 자동으로 잡는다.
  // 로고 전체(가로형)가 아니라 **책 마크만** 잘라 썼다 — 16px 로 줄면
  // 가로 로고의 글자는 뭉개져서 아무것도 안 보인다.
}

// 휴대폰에서 착상을 잡는 게 웹 전환의 주된 이유다. 확대 없이 읽히게 둔다.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  )
}
