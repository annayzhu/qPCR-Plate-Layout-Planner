import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { jsx } from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { PlateViewport } from "../app/PlateViewport";

function renderViewport(language: "zh" | "en", selectedWellIds: string[] = []) {
  const props: Parameters<typeof PlateViewport>[0] = {
    name: "Plate 01", rows: 16, columns: 24, language,
    editable: true, moveMode: false, selectedWellIds,
    editingToolbar: createElement("button", null, "Edit selected wells"),
    describeWell: (id: string) => id === "A1" ? "A1, A549-siZNF436-Long-NC-FAM, GAPDH" : "",
    onSelect() {},
    children: createElement("button", { "data-well-id": "A1" }, "A549-siZNF436-Long-NC-FAM"),
  };
  return renderToStaticMarkup(jsx(PlateViewport, props));
}

test("starts at readable scale and exposes accessible height and fullscreen controls", () => {
  const html = renderViewport("zh");
  assert.match(html, /data-plate-zoom="1\.000"/);
  assert.match(html, /role="separator"[^>]*tabindex="0"/);
  assert.match(html, /aria-label="调整孔板视区高度"/);
  assert.match(html, /aria-valuemin="320" aria-valuemax="1600"/);
  assert.match(html, /100% 阅读/);
  assert.match(html, /全屏查看/);
  assert.match(html, /Edit selected wells/);
});

test("shows the selected well's full identity independently of the scaled grid", () => {
  const html = renderViewport("zh", ["A1"]);
  assert.match(html, /class="well-inspector"[^]*?A1, A549-siZNF436-Long-NC-FAM, GAPDH/);
  assert.doesNotMatch(html, /悬停或点选孔位/);
});

test("offers the same reading and height controls in English", () => {
  const html = renderViewport("en");
  assert.match(html, /Resize plate viewport height/);
  assert.match(html, /Full screen/);
  assert.match(html, /100% detail/);
  assert.match(html, /Hover or select a well to read the full sample and assay names/);
});
