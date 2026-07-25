import type { Metadata, Viewport } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'mintAI — Scriptorium',
  description: '자신의 생각들을 키워나갈 수 있는 글쓰기 도구',
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
