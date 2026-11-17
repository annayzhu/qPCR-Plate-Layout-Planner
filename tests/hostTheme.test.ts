import assert from "node:assert/strict";
import test from "node:test";
import { hostThemeTokens } from "../app/hostTheme";

const tokens = {
  paper: "#f8f6fc", warm: "#fcfbfe", stone: "#f0ecf8", panel: "#e5def3", surface: "#ffffff",
  ink: "#26222f", graphite: "#514a63", muted: "#635b76", accent: "#6a55a8", accentHover: "#59478f",
  accentSurface: "#eeeafa", accentSurfaceHover: "#e6e0f7", accentBorder: "#cfc5ea", hairline: "#e4dfee", borderStrong: "#cfc7e0",
};

test("follows a LabNest style only when the shared payload is complete and well formed", () => {
  assert.equal(hostThemeTokens(JSON.stringify({ version: 1, themeId: "lilac-mist", tokens }))?.accent, "#6a55a8");
  assert.equal(hostThemeTokens(null), null);
  assert.equal(hostThemeTokens("not json"), null);
  assert.equal(hostThemeTokens(JSON.stringify({ version: 2, tokens })), null);
  assert.equal(hostThemeTokens(JSON.stringify({ version: 1, tokens: { ...tokens, accent: "red; background:url(x)" } })), null);
});
