import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the qPCR plate planner shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(
    html,
    /<title>qPCR 板布局规划工具<\/title>/i,
  );
  assert.match(html, /qPCR 板布局规划工具/);
  assert.match(html, /96 \/ 384 孔 · 排板与反应用量/);
  assert.match(html, /选择孔板/);
  assert.match(html, /样本与对照/);
  assert.match(html, /逐行设置名称及样本类型/);
  assert.match(html, /添加一行/);
  assert.match(html, /添加检测基因/);
  assert.match(html, /逐行设置名称及目的\/内参类型/);
  assert.match(html, /技术复孔/);
  assert.match(html, /按样本排列/);
  assert.match(html, /按基因排列/);
  assert.match(html, /纵向优先/);
  assert.match(html, /横向优先/);
  assert.match(html, /生成布局/);
  assert.match(html, /重置工具/);
  assert.match(html, /参数编辑/);
  assert.match(html, /⌘\/Ctrl\+Z 撤销/);
  assert.match(html, /列表可拖动排序/);
  assert.match(html, /setup-history-bar/);
  assert.match(html, /data-scroll-region="setup"/);
  assert.match(html, /data-scroll-region="plate-preview"/);
  assert.match(html, /aria-label="板布局工作区"/);
  assert.match(html, /导入 0 个样本名称/);
  assert.match(html, /导入 0 个基因名称/);
  assert.match(html, /样本数量（1–999）/);
  assert.match(html, /基因数量（1–999）/);
  assert.match(html, /快速添加/);
  assert.doesNotMatch(html, /生成 [ST]1/);
  assert.doesNotMatch(html, /Local-first/i);
  assert.doesNotMatch(html, /codex-preview/i);
  assert.doesNotMatch(html, /react-loading-skeleton/i);
});

test("declares the conditional reaction calculator scroll region", async () => {
  const source = await readFile(
    new URL("../app/ReactionCalculator.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /data-scroll-region="reaction-calculator"/);
});

test("declares the conditional plate box-selection affordance", async () => {
  const source = await readFile(
    new URL("../app/QpcrPlanner.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /拖动框选/);
  assert.match(source, /className="well-selection-box"/);
});

test("declares plate copy, paste, restore, and zoom editing affordances", async () => {
  const [source, styles] = await Promise.all([
    readFile(new URL("../app/QpcrPlanner.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(source, /复制所选孔（⌘\/Ctrl \+ C）/);
  assert.match(source, /粘贴到所选起始孔（⌘\/Ctrl \+ V）/);
  assert.match(source, /恢复所选/);
  assert.match(source, /孔板视图缩放/);
  assert.match(styles, /\.selection-toolbar\s*\{[^}]*position:\s*sticky/s);
});

test("keeps long plate sample lists collapsed behind a compact summary", async () => {
  const source = await readFile(
    new URL("../app/QpcrPlanner.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /activePlate\.sampleNames\.length} 个样本/);
  assert.match(source, /className="plate-sample-details"/);
  assert.match(source, /查看样本/);
});
