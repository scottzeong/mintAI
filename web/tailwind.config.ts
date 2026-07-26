import type { Config } from 'tailwindcss'
import typography from '@tailwindcss/typography'

/**
 * mint 팔레트.
 *
 * 저술 도구라 **장시간 읽고 쓰는 화면**이다. 그래서 채도를 낮게 잡았다 —
 * 선명한 민트는 처음엔 예쁘지만 30분 뒤에 눈이 아프다.
 *
 * 어두운 쪽(700~950)은 거의 무채색에 가까운 짙은 청록으로 뒀다. 본문 글자색이
 * 여기서 나오는데, 색이 강하면 글자가 아니라 색이 읽힌다.
 * 밝은 쪽(50~200)에서만 민트가 분명히 드러난다.
 *
 * ⚠ amber(경고)·red(오류)는 바꾸지 않았다. 그 둘은 장식이 아니라 **신호**다.
 *   민트로 칠하면 "주의"와 "정상"이 구분되지 않는다.
 */
const mint = {
  50: '#f1faf6',
  100: '#dcf3e8',
  200: '#b8e5d1',
  300: '#8ad0b3',
  400: '#57b291',
  500: '#369475',
  600: '#28775f',
  700: '#22604e',
  800: '#1e4d40',
  900: '#1a4036',
  950: '#0b241d',
}

export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: { mint },
      fontFamily: {
        sans: ['Pretendard', 'system-ui', '-apple-system', 'Malgun Gothic', 'sans-serif'],
      },
      // prose-mint — Write/Digest 미리보기에 쓴다
      typography: {
        mint: {
          css: {
            '--tw-prose-body': mint[800],
            '--tw-prose-headings': mint[900],
            '--tw-prose-lead': mint[700],
            '--tw-prose-links': mint[600],
            '--tw-prose-bold': mint[900],
            '--tw-prose-counters': mint[500],
            '--tw-prose-bullets': mint[300],
            '--tw-prose-hr': mint[200],
            '--tw-prose-quotes': mint[900],
            '--tw-prose-quote-borders': mint[200],
            '--tw-prose-captions': mint[500],
            '--tw-prose-code': mint[900],
            '--tw-prose-pre-code': mint[100],
            '--tw-prose-pre-bg': mint[900],
            '--tw-prose-th-borders': mint[300],
            '--tw-prose-td-borders': mint[200],
          },
        },
      },
    },
  },
  // Write 화면 미리보기(react-markdown 출력)에 필요하다. 없으면 `prose` 클래스가
  // 아무 효과도 내지 않아 제목·목록이 본문과 구분되지 않는다.
  plugins: [typography],
} satisfies Config
