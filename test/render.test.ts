import assert from "node:assert/strict";
import test from "node:test";
import {
  citationSourcesFromResults,
  formatLatex,
  normalizeAssistantText,
  normalizeMath,
  resolveCitations,
  StreamingCitationResolver,
  StreamingLinkResolver,
} from "../src/render.js";

test("citation metadata resolves private markers to clickable Markdown", () => {
  const sources = citationSourcesFromResults([
    {ref_id: "turn0search1", title: "Apple security releases", url: "https://support.apple.com/releases"},
  ]);
  assert.equal(
    resolveCitations("Current release. \uE200cite\uE202turn0search1\uE201", sources),
    "Current release. [Apple security releases](https://support.apple.com/releases)",
  );
});

test("multiple citations stay distinct and unresolved markers disappear", () => {
  const sources = citationSourcesFromResults([
    {ref_id: "turn0search0", title: "One", url: "https://example.com/one"},
    {ref_id: "turn0search1", title: "Two", url: "https://example.com/two"},
  ]);
  assert.equal(
    resolveCitations("Claim. \uE200cite\uE202turn0search0\uE202turn0search1\uE201", sources),
    "Claim. [1](https://example.com/one) [2](https://example.com/two)",
  );
  assert.equal(resolveCitations("Claim. \uE200cite\uE202turn9search9\uE201", sources), "Claim.");
});

test("streaming citations become links as soon as their marker completes", () => {
  const stream = new StreamingCitationResolver();
  const sources = [{refId: "turn0search1", title: "Reference", url: "https://example.com"}];
  assert.equal(stream.push("Claim. \uE200cite\uE202turn0", sources), "Claim. ");
  assert.equal(stream.push("search1", sources), "");
  assert.equal(stream.push("\uE201 More.", sources), "[Reference](https://example.com) More.");
});

test("streaming links reach the UI only when fully formed", () => {
  const stream = new StreamingLinkResolver();
  assert.equal(stream.push("See [Open"), "See ");
  assert.equal(stream.push("AI](https://developers."), "");
  assert.equal(stream.push("openai.com/docs) now."), "[OpenAI](https://developers.openai.com/docs) now.");
});

test("streaming image markup becomes one ordinary completed link", () => {
  const stream = new StreamingLinkResolver();
  assert.equal(stream.push("Photo: ![Chevrolet](https://example."), "Photo: ");
  assert.equal(stream.push("com/car.png)"), "[Chevrolet](https://example.com/car.png)");
});

test("common LaTeX becomes readable Unicode", () => {
  assert.equal(formatLatex("x^2 \\pm \\sqrt{b^2 - 4ac}"), "x² ± √(b² - 4ac)");
  assert.equal(formatLatex("\\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}"), "(-b ± √(b² - 4ac))/(2a)");
  assert.equal(formatLatex("\\sum_{i=1}^{n} i"), "∑ᵢ₌₁ⁿ i");
});

test("display and inline math format safely without touching currency", () => {
  assert.equal(normalizeMath("Use \\(x^2 + y^2\\)."), "Use x² + y².");
  assert.equal(normalizeMath("Answer:\n\\[x = \\frac{-b}{2a}\\]"), "Answer:\n\n```math\nx = (-b)/(2a)\n```");
  assert.equal(normalizeMath("It costs $5 and sometimes $10."), "It costs $5 and sometimes $10.");
});

test("the complete normalizer handles citations and math together", () => {
  const sources = [{refId: "turn0view0", title: "Reference", url: "https://example.com"}];
  assert.equal(
    normalizeAssistantText("\\(E = mc^2\\). \uE200cite\uE202turn0view0\uE201", sources),
    "E = mc². [Reference](https://example.com)",
  );
});
