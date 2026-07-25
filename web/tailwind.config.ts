import type { Config } from 'tailwindcss'
import typography from '@tailwindcss/typography'

export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Pretendard', 'system-ui', '-apple-system', 'Malgun Gothic', 'sans-serif'],
      },
    },
  },
  // Write 화면 미리보기(marked 출력)에 필요하다. 없으면 `prose` 클래스가
  // 아무 효과도 내지 않아 제목·목록이 본문과 구분되지 않는다.
  plugins: [typography],
} satisfies Config
