/** Trusted finite calibration fixtures; never evaluate source supplied by a report. */
export function finiteOracleSource(seed) {
  return `const n=${seed + 3}; const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b); const inputs=[n+1,n,n+1]; const rows=[
{id:'stable-unique-order',actual:[...new Set(inputs)].sort((a,b)=>a-b),expected:[n+1,n]},
{id:'signed-sum',actual:[n,-n-1].reduce((s,x)=>s+Math.abs(x),0),expected:-1},
{id:'clamp-upper',actual:Math.max(n+2,0),expected:n},
{id:'first-index',actual:[n,n].lastIndexOf(n),expected:0}];
console.log(JSON.stringify(rows.map(r=>({...r,detected:!same(r.actual,r.expected)}))));`;
}
export function finitePythonSource(seed, family) {
  if (family === "finite.refraction.python-sign") return `values=[${seed + 3},-${seed + 4}]\nassert sum(abs(x) for x in values) != sum(values)\n`;
  if (family === "finite.refraction.python-order") return `values=[${seed + 4},${seed + 3},${seed + 4}]\nassert sorted(set(values)) != list(dict.fromkeys(values))\n`;
  throw new TypeError("Unknown trusted finite Python fixture");
}
export function finiteFailingScentSource(seed, variant) {
  if (![1, 2].includes(variant)) throw new TypeError("Unknown finite scent variant");
  return `${finiteOracleSource(seed)}\n// independently executed scent variant ${variant}\nprocess.exit(9);\n`;
}
export function finiteExpectedRows(seed) {
  const n = seed + 3;
  return [
    { id: "stable-unique-order", actual: [n, n + 1], expected: [n + 1, n], detected: true },
    { id: "signed-sum", actual: 2 * n + 1, expected: -1, detected: true },
    { id: "clamp-upper", actual: n + 2, expected: n, detected: true },
    { id: "first-index", actual: 1, expected: 0, detected: true },
  ];
}
