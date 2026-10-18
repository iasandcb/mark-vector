// Punctuation for the browser's built-in dictation. Chrome's recognizer
// hands back Korean (and Japanese) with no punctuation at all, so a final
// phrase - what it settles on after a pause - gets it here:
//   - spoken marks: "마침표", "쉼표", "물음표", "느낌표" (and the Japanese
//     "句点"/"読点"/...) become the mark itself;
//   - a phrase that ends the way a sentence does ("...입니다", "...네요",
//     "...할까") gets "." or "?" - a pause mid-sentence ("그래서 이것은")
//     ends some other way and gets nothing.
// Other languages are left as they are: English has no ending to go by, and
// "period"/"comma" are ordinary words in a lecture.

const SPOKEN_MARKS = {
  ko: { 마침표: ".", 온점: ".", 쉼표: ",", 반점: ",", 물음표: "?", 느낌표: "!" },
  ja: { 句点: "。", 読点: "、", 疑問符: "？", 感嘆符: "！", まる: "。", てん: "、" },
};

const ENDS_WITH_MARK = /[.,?!。、？！…:;)\]"'”’」』]$/;

// Nouns that end in 요 without ending a sentence.
const YO_NOUNS = /(필요|중요|주요|수요|개요|강요|요요|불요|소요|월요|화요|목요|금요|토요|일요)$/;

function hasBatchim(syllable, jong) {
  const code = syllable.charCodeAt(0) - 0xac00;
  if (code < 0 || code > 11171) return false;
  return jong === undefined ? code % 28 !== 0 : code % 28 === jong;
}

function koreanEnding(text) {
  const word = text.split(/\s+/).pop();
  if (!word || !/[가-힣]$/.test(word)) return "";
  // "...ㅂ니까" (입니까, 합니까) asks; "...니까" alone (그러니까, 하니까) goes on.
  if (/니까$/.test(word)) return word.length >= 3 && hasBatchim(word[word.length - 3], 17) ? "?" : "";
  if (/(까|나요|[인은는]가요|냐)$/.test(word)) return "?";
  if (/요$/.test(word)) return YO_NOUNS.test(word) ? "" : ".";
  // "...보다" mid-sentence is a comparison ("이것보다"), not a verb.
  if (/.보다$/.test(word)) return "";
  if (/(다|죠|네|군)$/.test(word) && word.length >= 2) return ".";
  return "";
}

function japaneseEnding(text) {
  if (/か$/.test(text)) return "？";
  if (/(です|ます|でした|ました|ません|でしょう|ましょう|だ|た)$/.test(text)) return "。";
  return "";
}

function spokenMarks(text, marks) {
  const words = Object.keys(marks).join("|");
  return text.replace(new RegExp(`\\s*(${words})(?=\\s|$)`, "g"), (_, word) => marks[word]);
}

// `final` - whether the recognizer has settled on this phrase; an interim
// one only has its spoken marks swapped, since it may still go on.
export function punctuateSpeech(text, lang, { final = true } = {}) {
  const base = (lang || "").split("-")[0];
  const marks = SPOKEN_MARKS[base];
  if (!marks || !text.trim()) return text;
  let out = spokenMarks(text, marks);
  if (!final) return out;
  const trimmed = out.replace(/\s+$/, "");
  if (ENDS_WITH_MARK.test(trimmed)) return out;
  const mark = base === "ko" ? koreanEnding(trimmed) : japaneseEnding(trimmed);
  return mark ? trimmed + mark + out.slice(trimmed.length) : out;
}
