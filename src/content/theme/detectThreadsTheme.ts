export type ThreadsTheme = "light" | "dark";

type ParsedColor = Readonly<{
  red: number;
  green: number;
  blue: number;
  alpha: number;
}>;

const semanticAttributes = ["data-theme", "data-color-scheme"] as const;
const rgbPattern = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*(\d*\.?\d+))?\s*\)$/;

export function detectThreadsTheme(observedDocument: Document): ThreadsTheme {
  try {
    return (
      semanticTheme(observedDocument) ??
      colorSchemeTheme(observedDocument) ??
      brightnessTheme(observedDocument) ??
      "light"
    );
  } catch {
    return "light";
  }
}

function semanticTheme(observedDocument: Document): ThreadsTheme | null {
  for (const element of [observedDocument.documentElement, observedDocument.body]) {
    if (!element) continue;
    for (const attribute of semanticAttributes) {
      const value = element.getAttribute(attribute);
      if (value === "light" || value === "dark") return value;
    }
  }
  return null;
}

function colorSchemeTheme(observedDocument: Document): ThreadsTheme | null {
  const schemes = new Set<ThreadsTheme>();
  for (const style of styles(observedDocument)) {
    const scheme = parseColorScheme(style.colorScheme);
    if (scheme) schemes.add(scheme);
  }
  return schemes.size === 1 ? [...schemes][0] : null;
}

function brightnessTheme(observedDocument: Document): ThreadsTheme | null {
  const pageStyles = styles(observedDocument);
  const background = pageStyles
    .map((style) => parseColor(style.backgroundColor))
    .find((color) => color?.alpha === 1);
  if (background) return isBright(background) ? "light" : "dark";

  const foreground = pageStyles
    .map((style) => parseColor(style.color))
    .find((color) => color !== null && color.alpha > 0);
  return foreground ? (isBright(foreground) ? "dark" : "light") : null;
}

function styles(observedDocument: Document): CSSStyleDeclaration[] {
  const view = observedDocument.defaultView;
  if (!view) return [];
  const computed: CSSStyleDeclaration[] = [];
  for (const element of [observedDocument.body, observedDocument.documentElement]) {
    if (!element) continue;
    try {
      computed.push(view.getComputedStyle(element));
    } catch {
      // One unreadable page node must not hide a usable root style.
    }
  }
  return computed;
}

function parseColorScheme(value: string): ThreadsTheme | null {
  const themes = new Set(value.split(/\s+/).filter((token) => token === "light" || token === "dark"));
  return themes.size === 1 ? [...themes][0] : null;
}

function parseColor(value: string): ParsedColor | null {
  const match = rgbPattern.exec(value);
  if (!match) return null;
  const [red, green, blue] = match.slice(1, 4).map(Number);
  const alpha = match[4] === undefined ? 1 : Number(match[4]);
  if (
    [red, green, blue].some((channel) => channel < 0 || channel > 255) ||
    !Number.isFinite(alpha) ||
    alpha < 0 ||
    alpha > 1
  ) {
    return null;
  }
  return { red, green, blue, alpha };
}

function isBright({ red, green, blue }: ParsedColor): boolean {
  return red * 0.2126 + green * 0.7152 + blue * 0.0722 >= 128;
}
