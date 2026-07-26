/**
 * 글의 종류 (docs/STRUCTURING.md §8)
 *
 * ⚠ 이 파일과 `supabase/functions/structure/index.ts` 의 FORMATS 는
 *   **같은 값을 유지해야 한다.** 한쪽만 바꾸면 화면에 보이는 조건과 실제로
 *   생성되는 구조가 어긋난다. (Edge Function 은 Deno 라 import 를 공유할 수 없다)
 *
 * 종류마다 다른 것은 최소 카드 수만이 아니다. **구성 단위의 개수·이름·분량이
 * 전부 다르다.** 칼럼의 3개 덩어리를 "장"이라 부르면 어색하고, 책의 8개 장을
 * "단락"이라 부르면 규모가 안 잡힌다.
 */
export interface WorkFormat {
  key: 'column' | 'article' | 'report' | 'ebook' | 'book'
  label: string
  /** 이 형식을 제안받는 데 필요한 최소 카드 수 */
  minCards: number
  /** 구성 단위 이름 — 화면과 프롬프트에서 함께 쓴다 */
  unit: string
  /** 구성 단위 개수 범위 */
  units: [number, number]
  /** 목표 분량 (완성 기준) */
  length: string
  hint: string
}

export const FORMATS: WorkFormat[] = [
  {
    key: 'column',
    label: 'Column / Essay',
    minCards: 3,
    unit: '단락',
    units: [3, 5],
    length: '800~2,000자',
    hint: '하나의 주장을 끝까지 밀고 가는 짧은 글',
  },
  {
    key: 'article',
    label: 'Article / Post',
    minCards: 7,
    unit: '섹션',
    units: [3, 6],
    length: '2,000~5,000자',
    hint: '한 주제를 몇 갈래로 나눠 설명하는 글',
  },
  {
    key: 'report',
    label: 'Report / Paper',
    minCards: 15,
    unit: '절',
    units: [4, 8],
    length: '5,000~15,000자',
    hint: '근거를 갖춰 결론까지 논증하는 글',
  },
  {
    key: 'ebook',
    label: 'eBook / Monograph',
    minCards: 25,
    unit: '장',
    units: [5, 9],
    length: '20,000~50,000자',
    hint: '한 주제를 깊이 파는 소책자',
  },
  {
    key: 'book',
    label: 'Book',
    minCards: 50,
    unit: '장',
    units: [8, 14],
    length: '60,000자 이상',
    hint: '여러 갈래를 하나의 논지로 묶는 단행본',
  },
]

export const formatOf = (key: string): WorkFormat =>
  FORMATS.find((f) => f.key === key) ?? FORMATS[FORMATS.length - 1]

/** 가장 낮은 문턱 — 이보다 적으면 Structuring 자체가 열리지 않는다 */
export const MIN_CARDS_ANY = Math.min(...FORMATS.map((f) => f.minCards))
