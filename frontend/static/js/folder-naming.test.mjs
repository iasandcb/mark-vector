import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { createDraft, suggestConversationTitle } from "./api.js";

const source = fs.readFileSync(new URL("./app.js", import.meta.url), "utf8");

test("folder suggestions and drafts send the browser's local calendar day", async (t) => {
  const RealDate = Date;
  t.mock.method(globalThis, "Date", class extends RealDate {
    constructor() { super("2026-11-04T23:00:00Z"); }
    getFullYear() { return 2026; }
    getMonth() { return 10; }
    getDate() { return 5; }
  });
  const urls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    urls.push(new URL(url, "https://example.test"));
    return new Response(JSON.stringify({ title: "20261105" }));
  });
  assert.deepEqual(await suggestConversationTitle("project"), { title: "20261105" });
  await suggestConversationTitle("project", "parent");
  await createDraft("project", "folder");
  assert.equal(urls[0].pathname, "/api/projects/project/conversations/suggest-title");
  assert.equal(urls[0].searchParams.has("parent_id"), false);
  assert.equal(urls[1].searchParams.get("parent_id"), "parent");
  assert.equal(urls[2].pathname, "/api/projects/project/conversations/folder/documents");
  for (const url of urls) assert.equal(url.searchParams.get("today"), "2026-11-05");
});

for (const name of ["createSession", "createSubfolder"]) {
  for (const input of [" edited title ", "", null]) {
    test(`${name} prefills the suggestion and handles ${JSON.stringify(input)}`, async () => {
      const start = source.indexOf(`async function ${name}(`);
      const end = source.indexOf("\n}\n", start) + 2;
      const calls = [];
      const nested = name === "createSubfolder";
      const context = vm.createContext({
        api: {
          suggestConversationTitle: async (...args) => {
            assert.deepEqual(args, nested ? ["project", "parent"] : ["project"]);
            return { title: "20261105-2" };
          },
          createConversation: async (...args) => { calls.push(args); return { id: "new" }; },
        },
        requestWorkspaceName: async (prompt, value) => {
          assert.equal(prompt, "prompt.createFolder");
          assert.equal(value, "20261105-2");
          return input;
        },
        t: (key) => key,
        projects: new Map(),
        refreshProjectSessions: async () => {},
        saveExpandedTreeState() {},
        renderTree() {},
      });
      vm.runInContext(source.slice(start, end), context);
      await context[name]("project", ...(nested ? ["parent"] : []));
      if (input === null) assert.deepEqual(calls, []);
      else assert.deepEqual(calls, [["project", input.trim() || undefined, ...(nested ? ["parent"] : [])]]);
    });
  }
}
