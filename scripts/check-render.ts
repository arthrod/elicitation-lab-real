// Verify: (1) does json-render resolve in the BROWSER via esm.sh, and
// (2) do the component definitions carry enough to build renderers from?
const mod = await import("npm:@json-render/core@0.22.0");
const names = Object.keys(mod);
console.log("core:", names.filter((n) => /resolve|directive/i.test(n)).join(", "));

// What exactly is `readBinding`'s dependency surface?
const { createDirectiveRegistry, resolvePropValue } = mod as Record<string, Function>;
const { standardDirectives } = await import("npm:@json-render/directives@0.22.0");
const reg = createDirectiveRegistry(standardDirectives);

const cases: Array<[string, unknown]> = [
  ["plain", "hello"],
  ["$math", { $math: "subtract", a: 10, b: 3 }],
  ["$join", { $join: ["a", "b"], separator: " · " }],
  ["$pluralize", { $pluralize: 2, one: "day", other: "days" }],
  ["$format date", { $format: "date", value: "2026-11-19" }],
  ["$count", { $count: ["a", "b", "c"] }],
];
for (const [name, value] of cases) {
  console.log(name, "→", JSON.stringify(resolvePropValue(value, { directives: reg, state: {} })));
}
