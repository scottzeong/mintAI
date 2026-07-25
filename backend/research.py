"""리서치 파이프라인 — 검색 + LLM 정리 (docs/MVP.md §4).

이 모듈이 만드는 것은 **곧 폐기될 휘발성 자료**다 (원칙 1).
그래서 품질보다 중요한 게 두 가지 있다:

1. **1,200자 이내** — 길면 소화가 부담스러워지고, 그게 곧 R1 병목이다.
   읽는 데 5분 넘게 걸리는 자료는 "나중에 읽자"가 되고, 대기 큐가 쌓인다.
2. **"다른 관점" 필수** — 학술 기능이 아니라 사고 습관이다. 비용이 거의 없는데
   글의 깊이를 바꾼다.

공급자는 어댑터로 분리한다. 기본값은 `mock` — API 키 없이도 Digest 화면과
폐기 트랜잭션(원칙 1)을 전부 검증할 수 있어야 하기 때문이다.
MVP가 검증하려는 건 H1(요약 마찰 감내)이지 리서치 품질이 아니다.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field

MAX_OUTPUT_CHARS = 1200
MAX_SOURCES = 5


@dataclass
class ResearchResult:
    output_md: str
    sources: list[dict] = field(default_factory=list)
    model: str = "mock"

    def truncated(self) -> ResearchResult:
        """§4 규격 강제. 공급자가 규격을 어겨도 여기서 자른다."""
        out = self.output_md.strip()
        if len(out) > MAX_OUTPUT_CHARS:
            out = out[: MAX_OUTPUT_CHARS - 1].rstrip() + "…"
        return ResearchResult(out, self.sources[:MAX_SOURCES], self.model)


class ResearchError(RuntimeError):
    """리서치 실패. 사유는 research_runs.error 에 남고 화면에 그대로 표시된다."""


# ─────────────────────────── 공급자 ───────────────────────────


def _mock_provider(question: str) -> ResearchResult:
    """오프라인 공급자.

    실제 검색을 하지 않으므로 내용은 비어 있다 — **일부러 그렇게 둔다.**
    그럴듯한 가짜 문장을 넣으면 그걸 요약하게 되고, 그 요약이 카드로 영구 저장된다.
    거짓을 재료로 만든 카드는 나중에 구분할 방법이 없다.
    """
    return ResearchResult(
        output_md=(
            f"**Q. {question}**\n\n"
            "> ⚠ mock 공급자입니다. 실제 검색이 수행되지 않았습니다.\n"
            "> `MINTAI_RESEARCH_PROVIDER` 를 설정하면 실제 리서치로 바뀝니다.\n\n"
            "이 화면의 좌측은 **곧 폐기될 자료**입니다. 우측에 직접 요약을 쓰면\n"
            "이 텍스트는 사라지고 당신이 쓴 문장만 카드로 남습니다.\n"
        ),
        sources=[],
        model="mock",
    )


PROVIDERS = {"mock": _mock_provider}


def run_research(question: str) -> ResearchResult:
    """공급자를 골라 실행하고 §4 규격으로 정규화한다."""
    name = os.environ.get("MINTAI_RESEARCH_PROVIDER", "mock")
    provider = PROVIDERS.get(name)
    if provider is None:
        raise ResearchError(
            f"알 수 없는 리서치 공급자: {name!r} (가능: {', '.join(PROVIDERS)})"
        )
    return provider(question).truncated()
