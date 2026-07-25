'use client'

import ReactMarkdown from 'react-markdown'

/**
 * 마크다운 렌더러.
 *
 * ⚠ 왜 `marked` + `dangerouslySetInnerHTML` 이 아닌가 (MVP.md §6 변경):
 *
 *   Digest 좌측에 표시되는 자료는 **웹 검색 결과를 LLM 이 가공한 외부 콘텐츠**다.
 *   내가 쓴 글이 아니라 남이 쓴 웹페이지에서 온 문자열이다. 이걸 정화 없이
 *   innerHTML 로 넣으면 그 안의 `<script>`·`onerror` 가 그대로 실행된다.
 *
 *   react-markdown 은 마크다운을 React 엘리먼트로 직접 만든다. innerHTML 을
 *   쓰지 않고, 마크다운 안의 raw HTML 은 기본적으로 무시한다(rehype-raw 를
 *   넣지 않는 한). **정화 라이브러리를 붙이는 대신 정화가 필요 없는 구조를 쓴다.**
 *
 *   `marked` 를 유지하고 DOMPurify 를 붙이는 선택지도 있었지만, 그건 "위험한
 *   기본값 + 방어막" 이고 이쪽은 "안전한 기본값" 이다. 방어막은 빠뜨릴 수 있다.
 */
export default function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      components={{
        // 출처 링크는 새 탭으로. noreferrer 로 referrer 유출도 막는다.
        a: ({ children, ...props }) => (
          <a {...props} target="_blank" rel="noreferrer noopener">
            {children}
          </a>
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  )
}
