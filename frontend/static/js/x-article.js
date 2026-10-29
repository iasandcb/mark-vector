import { t } from "./i18n.js";
import { getXArticleConfig, createXArticleDraft } from "./api.js";

export async function openXArticleDialog(article) {
  if (document.querySelector(".x-article-dialog")) return;
  const dialog = document.createElement("dialog");
  dialog.className = "workspace-dialog x-article-dialog";
  dialog.setAttribute("aria-labelledby", "x-article-title");
  dialog.innerHTML = `<h2 id="x-article-title"></h2><p data-note></p>
    <label for="x-article-heading"></label><input id="x-article-heading" maxlength="1000">
    <ul data-warnings></ul><div class="x-article-preview" tabindex="0"></div>
    <p class="x-article-status" role="status" aria-live="polite"></p>
    <div class="workspace-dialog-actions"><button class="secondary-btn" data-close></button>
    <button class="primary-btn" data-create></button>
    <a class="primary-btn" data-open target="_blank" rel="noopener noreferrer" hidden></a></div>`;
  const $ = (selector) => dialog.querySelector(selector);
  $("h2").textContent = t("xArticle.title");
  $("[data-note]").textContent = t("xArticle.note");
  $("label").textContent = t("xArticle.heading");
  $("input").value = article.title;
  $("[data-close]").textContent = t("ui.close");
  $("[data-create]").textContent = t("xArticle.create");
  $("[data-open]").textContent = t("xArticle.open");
  for (const warning of article.warnings) {
    const li = document.createElement("li");
    li.textContent = t(`xArticle.warning.${warning}`);
    $("[data-warnings]").append(li);
  }
  $("[data-warnings]").hidden = !article.warnings.length;
  // Show the actual transformed content, with no remote images/HTML loaded.
  for (const block of article.content_state.blocks) {
    const row = document.createElement("div");
    row.className = `x-article-block x-article-${block.type}`;
    const embed = article.content_state.entities.find((entity) => Number(entity.key) === block.entity_ranges[0]?.key)?.value;
    if (block.type === "atomic") {
      row.textContent = embed?.data.markdown || (embed?.type === "divider" ? "———" : block.text);
    } else {
      const spans = [...block.inline_style_ranges, ...block.entity_ranges];
      const boundaries = [...new Set([0, block.text.length, ...spans.flatMap((span) => [span.offset, span.offset + span.length])])].sort((a, b) => a - b);
      for (let i = 0; i < boundaries.length - 1; i++) {
        const start = boundaries[i], end = boundaries[i + 1];
        let part = document.createTextNode(block.text.slice(start, end));
        for (const span of block.inline_style_ranges.filter((span) => span.offset <= start && span.offset + span.length >= end)) {
          const wrapper = document.createElement({ bold: "strong", italic: "em", strikethrough: "s" }[span.style]);
          wrapper.append(part); part = wrapper;
        }
        const linkRange = block.entity_ranges.find((span) => span.offset <= start && span.offset + span.length >= end);
        const link = article.content_state.entities.find((entity) => Number(entity.key) === linkRange?.key)?.value;
        if (link?.type === "link") {
          const anchor = document.createElement("a");
          anchor.href = link.data.url; anchor.target = "_blank"; anchor.rel = "noopener noreferrer";
          anchor.append(part); part = anchor;
        }
        row.append(part);
      }
    }
    $(".x-article-preview").append(row);
  }
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  let busy = false, configured = false, created = false;
  let requestId = crypto.randomUUID();
  const status = (key) => { $(".x-article-status").textContent = t(`xArticle.${key}`); };
  const update = () => {
    $("[data-create]").disabled = busy || !configured || !$("input").value.trim() || !article.content_state.blocks.length;
    $("input").disabled = busy || created;
    $("[data-close]").disabled = busy;
  };
  const error = (err) => {
    const key = `xArticle.error.${err.message}`;
    $(".x-article-status").textContent = t(key) === key ? t("xArticle.error.failed") : t(key);
  };
  const showResult = (result) => {
    created = true;
    $("[data-create]").hidden = true;
    $("[data-open]").hidden = false;
    $("[data-open]").href = result.url;
    status("created");
  };
  $("[data-close]").addEventListener("click", () => dialog.close());
  dialog.addEventListener("cancel", (event) => { if (busy) event.preventDefault(); });
  $("input").addEventListener("input", () => { requestId = crypto.randomUUID(); update(); });
  $("[data-create]").addEventListener("click", async () => {
    busy = true; update(); status("creating");
    try {
      showResult(await createXArticleDraft({ request_id: requestId, title: $("input").value.trim(), content_state: article.content_state }));
    } catch (err) { error(err); }
    finally { busy = false; update(); }
  });
  update();
  dialog.showModal();
  status("checking");
  try {
    configured = (await getXArticleConfig()).configured;
    status(configured ? (article.content_state.blocks.length ? "ready" : "empty") : "error.notConfigured");
  } catch (err) { error(err); }
  update();
}
