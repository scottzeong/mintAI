import type { Config } from 'tailwindcss'

export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Pretendard', 'system-ui', '-apple-system', 'Malgun Gothic', 'sans-serif'],
      },
    },
  },
  plugins: [],
} satisfies Config
