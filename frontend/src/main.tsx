import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { logEvent } from './api'
import './index.css'

// ★ 계측 (docs/MVP.md §2.2)
// 앱 진입 시 1회. 이 기록이 §8의 '사용 일수'와 '소화 대기 큐 평균'의 유일한 근거다.
// 4주가 지난 뒤에는 소급해서 만들 수 없으므로 Week 1부터 켜 둔다.
// meta 는 서버가 현재 대기 큐 길이로 채운다.
void logEvent('app_open')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
