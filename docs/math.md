[목차](README.md) · [README](../README.md)

## 수식 렌더링

KaTeX(LaTeX)와 [asciimath-markdown](https://github.com/iasandcb/asciimath-markdown)(AsciiMath2 → LaTeX 변환 후 KaTeX 렌더링. 변환 자체는 패키지 안의 [asciimath-parser](https://github.com/widcardw/asciimath-parser))를 jsDelivr CDN에서 로드해 사용합니다. 여기서 말하는 AsciiMath는 asciimath.org 원본 표준이 아니라 그 확장인 **AsciiMath2**입니다 — 표준 정의는 [asciimath2의 SPEC.md](https://github.com/iasandcb/asciimath2/blob/main/SPEC.md) 참고. KaTeX는 `index.html`에 `<script>` 태그로(`katex@0.18.4`), asciimath-markdown은 브라우저용으로 `frontend/static/js/markdown.js`가 `asciimath-markdown@0.4.2`를 ES 모듈로 `import`합니다. 둘 다 고정 버전으로 링크되어 있으므로, 실행 환경에 인터넷 접속이 필요합니다(오프라인 환경이라면 해당 파일들을 `frontend/static/vendor/`에 내려받아 로컬 경로로 바꿔주세요).

| 문법 | 종류 | 예시 |
|---|---|---|
| `$...$` | 인라인 수식 (기본 LaTeX, directive로 전환 가능) | `질량 $E=mc^2$ 등가식` |
| `$$...$$` | 블록 수식 (한 줄 또는 여러 줄, 기본 LaTeX, directive로 전환 가능) | `$$ \int_0^1 x^2\,dx = \tfrac13 $$` |
| `\(...\)` | 인라인 수식 (항상 LaTeX) | `질량 \(E=mc^2\) 등가식` |
| `\[...\]` | 블록 수식 (한 줄 또는 여러 줄, 항상 LaTeX) | `\[ \int_0^1 x^2\,dx = \tfrac13 \]` |
| ` ```asciimath ` | 블록 AsciiMath (항상 AsciiMath) | ` ```asciimath\nsqrt(2)/3\n``` ` |
| ` ```math ` / ` ```latex ` | 블록 LaTeX (항상 LaTeX) | ` ```math\n\frac{1}{2}\n``` ` |

`\(...\)`/`\[...\]`는 표준 LaTeX2e 명령이며(LLM들이 `$...$`/`$$...$$`보다 오히려 이쪽을 더 자주 씁니다), AsciiMath 대응 표기가 없으므로 ` ```math ` 펜스처럼 문서의 math directive와 무관하게 항상 LaTeX로 렌더링됩니다.

`$...$`/`$$...$$`가 기본으로는 LaTeX를 뜻하지만, 문서 아무 곳에나(주로 맨 위에) 아래 directive 주석을 넣으면 그 문서 전체에서 `$`/`$$`를 AsciiMath로 해석합니다. 여러 개 있으면 마지막 것이 적용되고, 이 주석 줄 자체는 렌더링 결과에는 나타나지 않습니다(다른 마크다운 뷰어에서 열어도 일반 HTML 주석이라 보이지 않습니다).

```
<!-- math: asciimath -->
```

```
<!-- math: latex -->
```

세 번째로 `hybrid`가 있습니다 — `$...$`/`$$...$$`는 `asciimath`와 똑같이 AsciiMath지만, `\(...\)`/`\[...\]`는 (원래부터 그렇듯) 항상 LaTeX라는 점을 **의도적으로 활용**하는 모드입니다: 같은 문서 안에서 어떤 수식은 `$`로, 어떤 수식은 `\(`로 써서 두 표기를 나란히 섞어 쓰겠다는 선택이고, "LaTeX → AsciiMath2 자동 변환"도 이 구분을 그대로 지킵니다(아래 참고).

```
<!-- math: hybrid -->
```

에디터 상단 수식 표기 드롭다운(LaTeX/AsciiMath/하이브리드)으로 현재 문서의 방식을 바로 바꿀 수 있고, 전환 시 필요하면 기존 수식도 함께 변환됩니다(AsciiMath2 ⇄ LaTeX 변환에 대한 안내는 아래 "LaTeX → AsciiMath2 자동 변환" 참고 — 하이브리드로 전환할 땐 `$`/`$$` 수식만 변환되고 `\(`/`\[` 수식은 그대로 남습니다).

` ```asciimath `/` ```math ` 펜스 블록은 이미 명시적이라 directive와 무관하게 항상 그대로 동작합니다.

인라인 AsciiMath 전용 구분자(`%...%`)는 제공하지 않습니다 — "10%에서 20%로" 같은 평범한 백분율 표기와 충돌하기 쉬워서, directive로 문서 전체의 `$` 의미를 바꾸는 방식으로 대체했습니다.

블록 수식에 여러 줄을 쓰면 dialect에 따라 다르게 처리됩니다.

- **LaTeX**(기본값)에서는 각 줄이 실제 줄바꿈으로 분리되고 가운데 정렬되어 렌더링됩니다(내부적으로 KaTeX의 `gathered` 환경 사용). 빈 줄은 무시됩니다.
- **AsciiMath2**에서는 AsciiMath2 자체의 정렬 문법을 그대로 씁니다 — 빈 줄이 행(row) 구분자이고, 각 행 안의 `&`는 정렬 마커로 그대로 전달됩니다([asciimath2 SPEC.md](https://github.com/iasandcb/asciimath2/blob/main/SPEC.md) 2.2절). 전체 블록을 한 번에 asciimath-parser에 넘기므로 `\begin{aligned}`/행렬(`[a,b;c,d]`) 구조가 그대로 살아납니다. 빈 줄이 없는 단일 표현식은 이전과 동일하게 한 줄로 렌더링됩니다.

`$$`/`\[`/`\]` 여는·닫는 마커는 그 줄에 단독으로 있지 않아도 됩니다 — LLM이 자주 쓰는 `\[A=\n\begin{bmatrix}...\end{bmatrix}\]`처럼 마커 바로 뒤/앞에 내용이 붙어 있어도 블록으로 인식합니다.

파싱에 실패한 수식은 오류를 표시할 뿐 전체 렌더링을 막지 않습니다.

### LaTeX → AsciiMath2 자동 변환

LLM이 직접 AsciiMath를 생성하면 품질이 떨어지는 경우가 많습니다(학습 데이터에 LaTeX가 압도적으로 많아서). 그래서 메시지를 보낼 때 전송 툴바의 수식 표기 드롭다운에서 **AsciiMath** 또는 **하이브리드**를 선택해두면, LLM에게는 평소처럼 LaTeX로 답하게 하고 — 응답이 저장되기 직전에 서버(`backend/app/latex_to_asciimath.py`, [`asciimath2`](https://github.com/iasandcb/asciimath2) 패키지 사용)가 수식을 하나씩 AsciiMath2로 변환을 시도합니다. **LaTeX**를 선택해두면 변환 없이 LLM 응답 그대로 저장됩니다.

- **AsciiMath** 선택 시: `$...$`/`$$...$$`/`\(...\)`/`\[...\]` 안의 수식을 전부 변환 대상으로 삼습니다. 성공한 것은 `$...$`/`$$...$$`(AsciiMath2)로 바뀌고, 문서 맨 위에 `<!-- math: asciimath -->`가 자동으로 붙습니다. 행렬·정렬 수식(`\begin{pmatrix}`, `\begin{aligned}` 등)도 변환됩니다 — `asciimath2`가 이런 구문을 지원하는 것이 이전에 쓰던 `py-asciimath`와 갈아탄 이유입니다.
- **하이브리드** 선택 시: `$...$`/`$$...$$` 안의 수식만 변환 대상으로 삼고, `\(...\)`/`\[...\]`는 변환을 시도조차 하지 않고 원본 LaTeX 그대로 둡니다 — LLM이 어느 표기를 썼는지에 따라 결과물이 두 표기로 자연스럽게 나뉩니다. 문서 맨 위에는 `<!-- math: hybrid -->`가 붙습니다.
- (두 모드 공통) 변환에 **실패**하면(asciimath2가 지원하지 않는 구문 — [asciimath2 README](https://github.com/iasandcb/asciimath2#readme)의 "Scope, honestly" 참고) 원본 LaTeX를 `\(...\)`/`\[...\]`로 남겨서 — directive와 무관하게 항상 LaTeX로 렌더링되므로 — 깨지지 않고 그대로 보입니다.
- 그 외에 조용히 틀린 결과를 내는(에러 없이) 경우까지는 자동으로 잡아내지 못합니다 — 이건 알려진 잔여 위험입니다.

문서의 수식 표기가 LaTeX가 아니면 응답을 변환하고, LaTeX면 변환하지 않습니다. 표기는 메시지마다 따로 기억하지 않고 열린 문서(와 상속 directive)를 따릅니다([프로바이더/모델/사고 수준/맥락은 메시지 단위이고, 수식 표기는 문서 단위입니다](models.md#프로바이더모델사고-수준맥락은-메시지-단위이고-수식-표기는-문서-단위입니다) 참고).
