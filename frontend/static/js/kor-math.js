// Spoken Korean math -> AsciiMath, for dictation inside a $$ block (see
// writeDictation in app.js). Pure string work, no DOM.
//
// The vocabulary isn't built in: it's the "공용 수식 말" CSV (one shared
// file, data/spoken-math.csv - seeded from backend/app/spoken_math_default.csv
// and edited in the app from then on), loaded with setSpokenMathVocabulary.
// One rule per line, "word, symbol": the word is everything before the
// first comma and the symbol everything after it, so a symbol may itself be
// a comma ("과, ,"). Lines starting with "#" are comments; a later line
// wins over an earlier one for the same word. Spaces inside a word don't
// matter - matching ignores spaces between Korean syllables, since
// recognizers space Korean inconsistently ("라지 에이" and "라지에이" alike).

let vocabulary = new Map();
let longestWord = 0;

export function parseSpokenMathCsv(content) {
  const rules = new Map();
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const comma = line.indexOf(",");
    if (comma === -1) continue;
    const word = line.slice(0, comma).replace(/\s+/g, "");
    const symbol = line.slice(comma + 1).trim();
    if (word && symbol) rules.set(word, symbol);
  }
  return rules;
}

export function setSpokenMathVocabulary(rules) {
  vocabulary = rules;
  longestWord = Math.max(0, ...[...rules.keys()].map((word) => word.length));
}

const HANGUL = /[가-힣]/;

// Sentence punctuation a recognizer adds on its own ("엑스 더하기 와이.") -
// meaningless in a formula. A "." or "," between digits stays (3.14, 1,000).
function dropSentencePunctuation(text) {
  return text.replace(/[.,?!。、，]/g, (mark, offset) =>
    (mark === "." || mark === ",") && /\d/.test(text[offset - 1] || "") && /\d/.test(text[offset + 1] || "") ? mark : " "
  );
}

// Longest match first over a run of Korean syllables (spaces removed), so
// "라지에이" is A rather than "라지" + a, and "집합 열고" is "{" rather than Set (.
// A syllable no word starts with is kept as it was said (a particle, say).
function convertHangulRun(run, out) {
  let i = 0;
  let unknown = "";
  while (i < run.length) {
    let matched = null;
    for (let len = Math.min(longestWord, run.length - i); len > 0; len--) {
      const symbol = vocabulary.get(run.slice(i, i + len));
      if (symbol !== undefined) {
        matched = { symbol, len };
        break;
      }
    }
    if (!matched) {
      unknown += run[i];
      i += 1;
      continue;
    }
    if (unknown) out.push(unknown);
    unknown = "";
    out.push(matched.symbol);
    i += matched.len;
  }
  if (unknown) out.push(unknown);
}

// "엑스 승 2 더하기 라지 와이 는 열고 에이 과 비 닫고" -> "x ^ 2 + Y = ( a , b )".
// Tokens come out space-separated; AsciiMath reads "x ^ 2" as x^2 all the
// same. Anything that isn't Korean (digits, letters the recognizer already
// wrote as x, symbols) passes through as its own token.
export function spokenMathToAsciiMath(text) {
  const out = [];
  const tokens = dropSentencePunctuation(text).split(/\s+/).filter(Boolean);
  let run = "";
  for (const token of tokens) {
    // Split a token like "x승" into its Korean and non-Korean stretches.
    for (const piece of token.match(/[가-힣]+|[^가-힣]+/g)) {
      if (HANGUL.test(piece)) {
        run += piece;
      } else {
        if (run) convertHangulRun(run, out);
        run = "";
        out.push(piece);
      }
    }
  }
  if (run) convertHangulRun(run, out);
  return out.join(" ");
}
