export interface CitationSource {
  refId: string;
  url: string;
  title: string;
}

interface SearchResult {
  ref_id?: unknown;
  url?: unknown;
  title?: unknown;
  domain?: unknown;
}

const SYMBOLS: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", theta: "θ",
  lambda: "λ", mu: "μ", pi: "π", rho: "ρ", sigma: "σ", tau: "τ", phi: "φ",
  psi: "ψ", omega: "ω", Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ",
  Pi: "Π", Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
  times: "×", cdot: "·", div: "÷", pm: "±", mp: "∓", neq: "≠", approx: "≈",
  equiv: "≡", le: "≤", leq: "≤", ge: "≥", geq: "≥", in: "∈", notin: "∉",
  subset: "⊂", subseteq: "⊆", supset: "⊃", supseteq: "⊇", cup: "∪", cap: "∩",
  infinity: "∞", infty: "∞", partial: "∂", nabla: "∇", sum: "∑", prod: "∏",
  int: "∫", oint: "∮", forall: "∀", exists: "∃", neg: "¬", land: "∧", lor: "∨",
  to: "→", rightarrow: "→", leftarrow: "←", leftrightarrow: "↔", implies: "⇒",
  therefore: "∴", because: "∵", degree: "°", angle: "∠", perp: "⊥",
};

const SUPERSCRIPT: Record<string, string> = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵",
  "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "+": "⁺", "-": "⁻",
  "=": "⁼", "(": "⁽", ")": "⁾", n: "ⁿ", i: "ⁱ",
};

const SUBSCRIPT: Record<string, string> = {
  "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅",
  "6": "₆", "7": "₇", "8": "₈", "9": "₉", "+": "₊", "-": "₋",
  "=": "₌", "(": "₍", ")": "₎", a: "ₐ", e: "ₑ", h: "ₕ", i: "ᵢ",
  j: "ⱼ", k: "ₖ", l: "ₗ", m: "ₘ", n: "ₙ", o: "ₒ", p: "ₚ", r: "ᵣ",
  s: "ₛ", t: "ₜ", u: "ᵤ", v: "ᵥ", x: "ₓ",
};

function sourceFromResult(value: unknown): CitationSource | null {
  if (!value || typeof value !== "object") return null;
  const result = value as SearchResult;
  if (typeof result.ref_id !== "string" || typeof result.url !== "string") return null;
  if (!/^https?:\/\//i.test(result.url)) return null;
  const fallback = typeof result.domain === "string" ? result.domain : "source";
  return {
    refId: result.ref_id,
    url: result.url,
    title: typeof result.title === "string" && result.title.trim() ? result.title.trim() : fallback,
  };
}

export function citationSourcesFromResults(results: unknown): CitationSource[] {
  if (!Array.isArray(results)) return [];
  return results.map(sourceFromResult).filter((source): source is CitationSource => source !== null);
}

function markdownUrl(url: string): string {
  return url.replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/\s/g, "%20");
}

function citationLabel(title: string): string {
  const clean = title.replace(/[\[\]\n\r]+/g, " ").replace(/\s+/g, " ").trim();
  return clean.length > 46 ? `${clean.slice(0, 43).trimEnd()}…` : (clean || "source");
}

export function resolveCitations(text: string, sources: Iterable<CitationSource>): string {
  const byId = new Map(Array.from(sources, (source) => [source.refId, source]));
  return text.replace(/\uE200cite(?:\uE202[^\uE201]*)?\uE201/g, (marker) => {
    const refs = Array.from(marker.matchAll(/turn\d+(?:search|view)\d+/g), (match) => match[0]);
    const resolved = refs.map((ref) => byId.get(ref)).filter((source): source is CitationSource => Boolean(source));
    if (!resolved.length) return "";
    if (resolved.length === 1) {
      const source = resolved[0];
      return `[${citationLabel(source.title)}](${markdownUrl(source.url)})`;
    }
    return resolved.map((source, index) => `[${index + 1}](${markdownUrl(source.url)})`).join(" ");
  }).replace(/[ \t]+\n/g, "\n").replace(/ {2,}/g, " ").trimEnd();
}

export class StreamingCitationResolver {
  private tail = "";

  reset(): void {
    this.tail = "";
  }

  push(delta: string, sources: Iterable<CitationSource>): string {
    let input = this.tail + delta;
    this.tail = "";
    let output = "";

    while (input) {
      const start = input.indexOf("\uE200");
      if (start < 0) return output + input;
      output += input.slice(0, start);
      const end = input.indexOf("\uE201", start + 1);
      if (end < 0) {
        this.tail = input.slice(start);
        return output;
      }
      const marker = input.slice(start, end + 1);
      output += resolveCitations(marker, sources);
      input = input.slice(end + 1);
    }
    return output;
  }
}

export class StreamingLinkResolver {
  private tail = "";

  reset(): void {
    this.tail = "";
  }

  push(delta: string): string {
    let input = this.tail + delta;
    this.tail = "";
    let output = "";

    while (input) {
      const bracket = input.indexOf("[");
      if (bracket < 0) return output + input;
      const start = bracket > 0 && input[bracket - 1] === "!" ? bracket - 1 : bracket;
      output += input.slice(0, start);

      const labelEnd = input.indexOf("]", bracket + 1);
      if (labelEnd < 0 || labelEnd + 1 >= input.length) {
        this.tail = input.slice(start);
        return output;
      }
      if (input[labelEnd + 1] !== "(") {
        output += input.slice(start, labelEnd + 1);
        input = input.slice(labelEnd + 1);
        continue;
      }

      let depth = 0;
      let linkEnd = -1;
      for (let index = labelEnd + 1; index < input.length; index++) {
        if (input[index] === "(") depth++;
        else if (input[index] === ")" && --depth === 0) {
          linkEnd = index;
          break;
        }
      }
      if (linkEnd < 0) {
        this.tail = input.slice(start);
        return output;
      }

      const label = input.slice(bracket + 1, labelEnd);
      const url = input.slice(labelEnd + 2, linkEnd).trim();
      output += /^https?:\/\//i.test(url)
        ? `[${label}](${url})`
        : input.slice(start, linkEnd + 1);
      input = input.slice(linkEnd + 1);
    }
    return output;
  }
}

function readGroup(input: string, start: number): {value: string; end: number} | null {
  if (input[start] !== "{") return null;
  let depth = 0;
  for (let index = start; index < input.length; index++) {
    if (input[index] === "{") depth++;
    else if (input[index] === "}" && --depth === 0) return {value: input.slice(start + 1, index), end: index + 1};
  }
  return null;
}

function replaceGroupedCommand(input: string, command: string, groups: number, render: (values: string[]) => string): string {
  let output = "";
  let cursor = 0;
  const needle = `\\${command}`;
  while (cursor < input.length) {
    const found = input.indexOf(needle, cursor);
    if (found < 0) return output + input.slice(cursor);
    output += input.slice(cursor, found);
    let position = found + needle.length;
    while (input[position] === " ") position++;
    const values: string[] = [];
    for (let index = 0; index < groups; index++) {
      const group = readGroup(input, position);
      if (!group) break;
      values.push(group.value);
      position = group.end;
      while (input[position] === " ") position++;
    }
    if (values.length !== groups) {
      output += needle;
      cursor = found + needle.length;
    } else {
      output += render(values);
      cursor = position;
    }
  }
  return output;
}

function scriptValue(value: string, alphabet: Record<string, string>, fallback: string): string {
  const converted = Array.from(value).map((character) => alphabet[character]).join("");
  return converted.length === value.length ? converted : `${fallback}(${value})`;
}

export function formatLatex(input: string): string {
  let value = input.trim();
  for (let pass = 0; pass < 4; pass++) {
    value = replaceGroupedCommand(value, "frac", 2, ([top, bottom]) => `(${formatLatex(top)})/(${formatLatex(bottom)})`);
    value = replaceGroupedCommand(value, "sqrt", 1, ([inside]) => `√(${formatLatex(inside)})`);
    value = replaceGroupedCommand(value, "text", 1, ([inside]) => inside);
    value = replaceGroupedCommand(value, "operatorname", 1, ([inside]) => inside);
  }
  value = value
    .replace(/\\begin\{(?:aligned\*?|equation\*?|gathered|matrix|pmatrix|bmatrix)\}/g, "")
    .replace(/\\end\{(?:aligned\*?|equation\*?|gathered|matrix|pmatrix|bmatrix)\}/g, "")
    .replace(/\\(?:left|right|displaystyle)\b/g, "")
    .replace(/\\(?:quad|qquad|,|;|!|:)\s*/g, " ")
    .replace(/\\\\/g, "\n")
    .replace(/&/g, "")
    .replace(/\\([A-Za-z]+)/g, (match, name: string) => SYMBOLS[name] || name)
    .replace(/\^\{([^{}]+)\}/g, (_, script: string) => scriptValue(script, SUPERSCRIPT, "^"))
    .replace(/_\{([^{}]+)\}/g, (_, script: string) => scriptValue(script, SUBSCRIPT, "_"))
    .replace(/\^([0-9+\-=()ni])/g, (_, script: string) => SUPERSCRIPT[script] || `^${script}`)
    .replace(/_([0-9+\-=()aehijklmnoprstuvx])/g, (_, script: string) => SUBSCRIPT[script] || `_${script}`)
    .replace(/[{}]/g, "")
    .replace(/~/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*([=+×÷±≤≥≠≈→])\s*/g, " $1 ")
    .trim();
  return value;
}

function mathFence(expression: string): string {
  return `\n\n\`\`\`math\n${formatLatex(expression)}\n\`\`\`\n\n`;
}

export function normalizeMath(markdown: string): string {
  let value = markdown
    .replace(/\$\$([\s\S]*?)\$\$/g, (_, expression: string) => mathFence(expression))
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, expression: string) => mathFence(expression))
    .replace(/\\begin\{equation\*?\}([\s\S]*?)\\end\{equation\*?\}/g, (_, expression: string) => mathFence(expression))
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, expression: string) => formatLatex(expression));

  value = value.replace(/\$([^$\n]+)\$/g, (whole, expression: string) => {
    return /\\[A-Za-z]+|[=^_+*/<>]|^[A-Za-z]$/.test(expression) ? formatLatex(expression) : whole;
  });
  return value.replace(/\n{3,}/g, "\n\n").trim();
}

export function normalizeAssistantText(text: string, sources: Iterable<CitationSource> = []): string {
  return normalizeMath(resolveCitations(String(text || "").replace(/\r\n?/g, "\n"), sources));
}
