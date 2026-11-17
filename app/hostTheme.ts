/**
 * Inside LabNest (same origin) the planner follows the current system style, which LabNest
 * publishes as light tokens under this key. Standalone and offline copies never see the key and
 * keep their own colours. Data colours (genes, reference) are not touched.
 */
export const HOST_THEME_KEY = "labnest.tool-theme.v1";

const MAPPING: Record<string, string> = {
  "--canvas": "paper",
  "--surface-soft": "stone",
  "--surface-raised": "warm",
  "--ink": "ink",
  "--ink-secondary": "muted",
  "--border": "hairline",
  "--border-strong": "borderStrong",
  "--action": "accent",
  "--action-hover": "accentHover",
  "--action-soft": "accentSurface",
  "--focus": "accentBorder",
  "--plate-tray-a": "stone",
  "--plate-tray-b": "panel",
  "--plate-tray-border": "borderStrong",
  "--plate-empty": "warm",
  "--plate-empty-border": "accentBorder",
};

export function hostThemeTokens(raw: string | null): Record<string, string> | null {
  try {
    const payload = JSON.parse(raw ?? "null");
    const tokens = payload?.version === 1 ? payload.tokens : null;
    if (!tokens) return null;
    const values = Object.values(MAPPING).map((name) => tokens[name]);
    return values.every((value) => /^#[0-9a-f]{6}$/i.test(String(value))) ? tokens : null;
  } catch {
    return null;
  }
}

export function applyHostTheme(root: HTMLElement, raw: string | null) {
  const tokens = hostThemeTokens(raw);
  for (const [property, token] of Object.entries(MAPPING)) {
    if (tokens) root.style.setProperty(property, tokens[token]);
    else root.style.removeProperty(property);
  }
}

if (typeof window !== "undefined") {
  const read = () => {
    try {
      return window.localStorage.getItem(HOST_THEME_KEY);
    } catch {
      return null;
    }
  };
  applyHostTheme(document.documentElement, read());
  window.addEventListener("storage", (event) => {
    if (event.key === HOST_THEME_KEY || event.key === null) applyHostTheme(document.documentElement, read());
  });
}
