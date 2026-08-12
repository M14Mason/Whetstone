'use strict';

const {
  randInt, randNonZero, pick, fmt, signed, buildChoices, numericFallback,
} = require('./generator-core');

/**
 * Math question templates.
 *
 * Each template picks parameters, computes the answer, and derives distractors
 * from mistakes a student actually makes: dropping a negative, forgetting to
 * divide, stopping one step early, or using the wrong formula entirely.
 */

const PYTHAGOREAN_TRIPLES = [
  [3, 4, 5], [6, 8, 10], [5, 12, 13], [8, 15, 17], [9, 12, 15],
  [7, 24, 25], [20, 21, 29], [12, 16, 20], [10, 24, 26], [15, 20, 25],
  [9, 40, 41], [12, 35, 37], [18, 24, 30], [14, 48, 50], [16, 30, 34],
];

const templates = [
  // ---------------------------------------------------------------- linear
  {
    idPrefix: 'gen-math-lin1', subject: 'Math', topic: 'Linear Equations', difficulty: 'easy',
    build(rng) {
      const a = randInt(rng, 2, 9);
      const x = randInt(rng, -9, 12);
      const b = randNonZero(rng, -15, 15);
      const c = a * x + b;
      return {
        prompt: `Solve for x:  ${a}x ${signed(b)} = ${c}`,
        explanation: `Subtract ${b} from both sides: ${a}x = ${c - b}. Divide by ${a}: x = ${x}.`,
        ...buildChoices(rng, fmt(x), [
          fmt((c + b) / a),   // added instead of subtracted
          fmt(c - b),         // forgot to divide
          fmt(-x),            // sign slip
        ], numericFallback(x)),
      };
    },
  },
  {
    idPrefix: 'gen-math-lin2', subject: 'Math', topic: 'Linear Equations', difficulty: 'medium',
    build(rng) {
      const a = randInt(rng, 2, 8);
      const c = randInt(rng, 2, 8);
      if (a === c) return null;
      const x = randInt(rng, -8, 10);
      const b = randNonZero(rng, -12, 12);
      const d = (a - c) * x + b;
      return {
        prompt: `Solve for x:  ${a}x ${signed(b)} = ${c}x ${signed(d)}`,
        explanation: `Move the x terms together: ${a - c}x = ${d - b}. Divide by ${a - c}: x = ${fmt(x)}.`,
        ...buildChoices(rng, fmt(x), [
          fmt((b - d) / (a - c)),
          fmt((d - b) / (a + c)),
          fmt(-x),
        ], numericFallback(x)),
      };
    },
  },
  {
    idPrefix: 'gen-math-lin3', subject: 'Math', topic: 'Linear Equations', difficulty: 'medium',
    build(rng) {
      const a = randInt(rng, 2, 6);
      const b = randNonZero(rng, -9, 9);
      const x = randInt(rng, -7, 9);
      const rhs = a * (x + b);
      return {
        prompt: `Solve for x:  ${a}(x ${signed(b)}) = ${rhs}`,
        explanation: `Divide both sides by ${a}: x ${signed(b)} = ${rhs / a}. Then x = ${fmt(x)}.`,
        ...buildChoices(rng, fmt(x), [
          fmt(rhs / a + b),      // sign error undoing b
          fmt(rhs - b),          // ignored the coefficient
          fmt(rhs / a),          // stopped one step early
        ], numericFallback(x)),
      };
    },
  },
  {
    idPrefix: 'gen-math-lin4', subject: 'Math', topic: 'Linear Equations', difficulty: 'hard',
    build(rng) {
      const a = randInt(rng, 2, 7);
      const x = randInt(rng, 2, 9);
      const b = randNonZero(rng, -10, 10);
      const c = a * x + b;
      const multiple = randInt(rng, 2, 4);
      return {
        prompt: `If ${a}x ${signed(b)} = ${c}, what is the value of ${multiple}x?`,
        explanation: `First ${a}x = ${c - b}, so x = ${x}. The question asks for ${multiple}x, which is ${multiple * x}. Solving for x and stopping there is the trap.`,
        ...buildChoices(rng, fmt(multiple * x), [
          fmt(x),                      // answered the wrong quantity
          fmt(multiple * x + b),
          fmt(x * (multiple + 1)),
        ], numericFallback(multiple * x)),
      };
    },
  },

  // ----------------------------------------------------------- lines/slope
  {
    idPrefix: 'gen-math-slope', subject: 'Math', topic: 'Linear Equations', difficulty: 'medium',
    build(rng) {
      const x1 = randInt(rng, -8, 4);
      const run = randInt(rng, 1, 6);
      const x2 = x1 + run;
      const slope = randNonZero(rng, -5, 5);
      const y1 = randInt(rng, -9, 9);
      const y2 = y1 + slope * run;
      return {
        prompt: `What is the slope of the line through (${x1}, ${y1}) and (${x2}, ${y2})?`,
        explanation: `Slope = (${y2} - ${y1}) / (${x2} - ${x1}) = ${y2 - y1}/${x2 - x1} = ${fmt(slope)}.`,
        ...buildChoices(rng, fmt(slope), [
          fmt(-slope),
          fmt((x2 - x1) / (y2 - y1)),   // inverted the fraction
          fmt((y2 + y1) / (x2 + x1)),
        ], numericFallback(slope)),
      };
    },
  },
  {
    idPrefix: 'gen-math-yint', subject: 'Math', topic: 'Linear Equations', difficulty: 'hard',
    build(rng) {
      const slope = randNonZero(rng, -4, 5);
      const b = randInt(rng, -9, 9);
      const x1 = randInt(rng, 1, 5);
      const run = randInt(rng, 1, 5);
      const x2 = x1 + run;
      const y1 = slope * x1 + b;
      const y2 = slope * x2 + b;
      return {
        prompt: `A line passes through (${x1}, ${y1}) and (${x2}, ${y2}). What is its y-intercept?`,
        explanation: `Slope = ${y2 - y1}/${x2 - x1} = ${fmt(slope)}. Using y = ${fmt(slope)}x + b with (${x1}, ${y1}): ${y1} = ${fmt(slope * x1)} + b, so b = ${fmt(b)}.`,
        ...buildChoices(rng, fmt(b), [
          fmt(slope),          // gave the slope instead
          fmt(-b),
          fmt(y1),             // gave a y-value from the table
        ], numericFallback(b)),
      };
    },
  },

  // ------------------------------------------------------------- quadratic
  {
    idPrefix: 'gen-math-quad1', subject: 'Math', topic: 'Quadratics', difficulty: 'medium',
    build(rng) {
      const r1 = randNonZero(rng, -8, 8);
      let r2 = randNonZero(rng, -8, 8);
      if (r1 === r2) r2 = r1 + 1 === 0 ? r1 + 2 : r1 + 1;
      const b = -(r1 + r2);
      const c = r1 * r2;
      const lo = Math.min(r1, r2);
      const hi = Math.max(r1, r2);
      return {
        prompt: `What are the solutions to x^2 ${signed(b)}x ${signed(c)} = 0?`,
        explanation: `Factor into (x ${signed(-r1)})(x ${signed(-r2)}) = 0, which gives x = ${lo} and x = ${hi}.`,
        ...buildChoices(rng, `x = ${lo} and x = ${hi}`, [
          `x = ${-lo} and x = ${-hi}`,   // forgot to flip the sign when factoring
          `x = ${lo} and x = ${-hi}`,
          `x = ${b} and x = ${c}`,       // read coefficients as roots
        ], (i) => `x = ${lo + i + 1} and x = ${hi + i + 1}`),
      };
    },
  },
  {
    idPrefix: 'gen-math-quad2', subject: 'Math', topic: 'Quadratics', difficulty: 'medium',
    build(rng) {
      const h = randInt(rng, -6, 7);
      const k = randInt(rng, -9, 9);
      const b = -2 * h;
      const c = h * h + k;
      return {
        prompt: `What is the vertex of the parabola y = x^2 ${signed(b)}x ${signed(c)}?`,
        explanation: `Vertex x = -b/(2a) = ${fmt(h)}. Substituting: y = ${fmt(h)}^2 ${signed(b * h)} ${signed(c)} = ${fmt(k)}. The vertex is (${h}, ${k}).`,
        ...buildChoices(rng, `(${h}, ${k})`, [
          `(${-h}, ${k})`,    // forgot the negative in -b/2a
          `(${h}, ${-k})`,
          `(${b}, ${c})`,     // read off the coefficients
        ], (i) => `(${h + i + 1}, ${k - i - 1})`),
      };
    },
  },
  {
    idPrefix: 'gen-math-quad3', subject: 'Math', topic: 'Quadratics', difficulty: 'hard',
    build(rng) {
      const a = randInt(rng, 1, 4);
      const b = randInt(rng, -8, 8);
      const c = randInt(rng, -6, 9);
      const disc = b * b - 4 * a * c;
      const answer = disc > 0 ? 'Two' : disc === 0 ? 'Exactly one' : 'None';
      const sign = disc > 0 ? 'positive' : disc === 0 ? 'zero' : 'negative';
      return {
        prompt: `How many real solutions does ${a}x^2 ${signed(b)}x ${signed(c)} = 0 have?`,
        explanation: `The discriminant is b^2 - 4ac = ${b * b} - ${4 * a * c} = ${disc}. A ${sign} discriminant means ${answer.toLowerCase()} real solution${answer === 'Two' ? 's' : ''}.`,
        ...buildChoices(rng, answer, ['Two', 'Exactly one', 'None', 'Infinitely many']
          .filter((x) => x !== answer), () => 'Cannot be determined'),
      };
    },
  },

  // --------------------------------------------------------------- systems
  {
    idPrefix: 'gen-math-sys1', subject: 'Math', topic: 'Systems of Equations', difficulty: 'medium',
    build(rng) {
      const x = randInt(rng, 1, 12);
      const y = randInt(rng, 1, 12);
      if (x === y) return null;
      return {
        prompt: `If x + y = ${x + y} and x - y = ${x - y}, what is the value of xy?`,
        explanation: `Adding the equations gives 2x = ${2 * x}, so x = ${x} and y = ${y}. Therefore xy = ${x * y}.`,
        ...buildChoices(rng, fmt(x * y), [
          fmt(x + y),
          fmt(x - y),
          fmt(x * y + (x + y)),
        ], numericFallback(x * y)),
      };
    },
  },
  {
    idPrefix: 'gen-math-sys2', subject: 'Math', topic: 'Systems of Equations', difficulty: 'hard',
    build(rng) {
      const a = randInt(rng, 2, 5);
      const b = randInt(rng, 2, 5);
      const y = randInt(rng, 1, 9);
      const k = randInt(rng, 1, 6);
      const x = y + k;
      const total = a * x + b * y;
      return {
        prompt: `Solve for x:  ${a}x + ${b}y = ${total} and x = y + ${k}`,
        explanation: `Substitute: ${a}(y + ${k}) + ${b}y = ${total}, so ${a + b}y = ${total - a * k} and y = ${y}. Then x = ${y} + ${k} = ${x}.`,
        ...buildChoices(rng, fmt(x), [
          fmt(y),      // solved for y and stopped
          fmt(x + k),
          fmt(y - k),
        ], numericFallback(x)),
      };
    },
  },

  // ------------------------------------------------------------- exponents
  {
    idPrefix: 'gen-math-exp1', subject: 'Math', topic: 'Exponents and Radicals', difficulty: 'easy',
    build(rng) {
      const base = pick(rng, [2, 3, 5]);
      const m = randInt(rng, 2, 3);
      const n = randInt(rng, 2, 3);
      const value = Math.pow(base, m * n);
      if (value > 100000) return null;
      return {
        prompt: `What is the value of (${base}^${m})^${n}?`,
        explanation: `Raising a power to a power multiplies exponents: ${base}^(${m} x ${n}) = ${base}^${m * n} = ${value}.`,
        ...buildChoices(rng, fmt(value), [
          fmt(Math.pow(base, m + n)),   // added exponents instead
          fmt(Math.pow(base, m) * n),
          fmt(base * m * n),
        ], numericFallback(value)),
      };
    },
  },
  {
    idPrefix: 'gen-math-exp2', subject: 'Math', topic: 'Exponents and Radicals', difficulty: 'medium',
    build(rng) {
      const p = randInt(rng, 5, 12);
      const q = randInt(rng, 1, 4);
      const r = randInt(rng, 1, 3);
      const result = p - q + r;
      return {
        prompt: `Simplify:  (x^${p} / x^${q}) * x^${r}`,
        explanation: `Dividing subtracts exponents: x^${p - q}. Multiplying adds: x^${p - q} * x^${r} = x^${result}.`,
        ...buildChoices(rng, `x^${result}`, [
          `x^${p - q - r}`,
          `x^${p + q + r}`,
          `x^${p * q * r}`,
        ], (i) => `x^${result + i + 1}`),
      };
    },
  },
  {
    idPrefix: 'gen-math-exp3', subject: 'Math', topic: 'Exponents and Radicals', difficulty: 'hard',
    build(rng) {
      const base = pick(rng, [2, 3]);
      const outer = randInt(rng, 2, 3);
      const target = randInt(rng, 3, 6);
      const x = target / outer;
      const left = Math.pow(base, outer);
      const right = Math.pow(base, target);
      if (right > 100000) return null;
      return {
        prompt: `If ${left}^x = ${right}, what is x?`,
        explanation: `Write both sides in base ${base}: (${base}^${outer})^x = ${base}^${target}, so ${outer}x = ${target} and x = ${fmt(x)}.`,
        ...buildChoices(rng, fmt(x), [
          fmt(target),
          fmt(outer),
          fmt(target * outer),
        ], numericFallback(x)),
      };
    },
  },

  // ------------------------------------------------------------- geometry
  {
    idPrefix: 'gen-math-pyth', subject: 'Math', topic: 'Triangles', difficulty: 'easy',
    build(rng) {
      const [a, b, c] = pick(rng, PYTHAGOREAN_TRIPLES);
      return {
        prompt: `A right triangle has legs of length ${a} and ${b}. What is the length of the hypotenuse?`,
        explanation: `${a}^2 + ${b}^2 = ${a * a} + ${b * b} = ${c * c}, and the square root of ${c * c} is ${c}.`,
        ...buildChoices(rng, fmt(c), [
          fmt(a + b),          // added the legs
          fmt(c + 1),
          fmt(Math.abs(b - a)),
        ], numericFallback(c)),
      };
    },
  },
  {
    idPrefix: 'gen-math-pyth2', subject: 'Math', topic: 'Triangles', difficulty: 'medium',
    build(rng) {
      const [a, b, c] = pick(rng, PYTHAGOREAN_TRIPLES);
      return {
        prompt: `A right triangle has a hypotenuse of ${c} and one leg of ${a}. What is the other leg?`,
        explanation: `${c}^2 - ${a}^2 = ${c * c} - ${a * a} = ${b * b}, and the square root of ${b * b} is ${b}.`,
        ...buildChoices(rng, fmt(b), [
          fmt(c - a),           // subtracted the lengths directly
          fmt(c + a),
          fmt(Math.round(Math.sqrt(c * c + a * a))),
        ], numericFallback(b)),
      };
    },
  },
  {
    idPrefix: 'gen-math-triang', subject: 'Math', topic: 'Triangles', difficulty: 'medium',
    build(rng) {
      const ratios = pick(rng, [[1, 2, 3], [2, 3, 4], [3, 4, 5], [1, 1, 2], [2, 2, 5], [1, 3, 5], [4, 5, 6]]);
      const total = ratios.reduce((s, r) => s + r, 0);
      if (180 % total !== 0) return null;
      const unit = 180 / total;
      const largest = Math.max(...ratios) * unit;
      const smallest = Math.min(...ratios) * unit;
      return {
        prompt: `The angles of a triangle are in the ratio ${ratios.join(':')}. What is the measure of the largest angle?`,
        explanation: `The ratio has ${total} parts and the angles sum to 180, so each part is ${unit} degrees. The largest angle is ${Math.max(...ratios)} x ${unit} = ${largest} degrees.`,
        ...buildChoices(rng, `${largest} degrees`, [
          `${smallest} degrees`,
          `${unit} degrees`,
          `${Math.max(...ratios) * 10} degrees`,
        ], (i) => `${largest + (i + 1) * 5} degrees`),
      };
    },
  },
  {
    idPrefix: 'gen-math-tarea', subject: 'Math', topic: 'Triangles', difficulty: 'medium',
    build(rng) {
      const base = randInt(rng, 2, 14);
      const height = randInt(rng, 2, 14);
      const area = (base * height) / 2;
      return {
        prompt: `What is the area of a triangle with a base of ${base} and a height of ${height}?`,
        explanation: `Area = (1/2) x base x height = (1/2) x ${base} x ${height} = ${fmt(area)}.`,
        ...buildChoices(rng, fmt(area), [
          fmt(base * height),        // forgot the one half
          fmt(base + height),
          fmt(2 * base * height),
        ], numericFallback(area)),
      };
    },
  },
  {
    idPrefix: 'gen-math-circ1', subject: 'Math', topic: 'Circles', difficulty: 'easy',
    build(rng) {
      const r = randInt(rng, 2, 14);
      return {
        prompt: `What is the area of a circle with radius ${r}?`,
        explanation: `Area = pi * r^2 = pi * ${r}^2 = ${r * r} pi. (${2 * r} pi is the circumference, a common trap.)`,
        ...buildChoices(rng, `${r * r} pi`, [
          `${2 * r} pi`,      // gave circumference
          `${r} pi`,
          `${r * r * 2} pi`,
        ], (i) => `${r * r + (i + 1) * 3} pi`),
      };
    },
  },
  {
    idPrefix: 'gen-math-circ2', subject: 'Math', topic: 'Circles', difficulty: 'medium',
    build(rng) {
      const r = randInt(rng, 2, 12);
      return {
        prompt: `A circle has a circumference of ${2 * r} pi. What is its area?`,
        explanation: `Circumference = 2 pi r = ${2 * r} pi, so r = ${r}. Area = pi r^2 = ${r * r} pi.`,
        ...buildChoices(rng, `${r * r} pi`, [
          `${4 * r * r} pi`,   // used the diameter as the radius
          `${2 * r} pi`,
          `${r} pi`,
        ], (i) => `${r * r + (i + 1) * 4} pi`),
      };
    },
  },
  {
    idPrefix: 'gen-math-dist', subject: 'Math', topic: 'Coordinate Geometry', difficulty: 'medium',
    build(rng) {
      const [a, b, c] = pick(rng, PYTHAGOREAN_TRIPLES);
      const x1 = randInt(rng, -6, 6);
      const y1 = randInt(rng, -6, 6);
      const x2 = x1 + a;
      const y2 = y1 + b;
      return {
        prompt: `What is the distance between (${x1}, ${y1}) and (${x2}, ${y2})?`,
        explanation: `The horizontal change is ${a} and the vertical change is ${b}. Distance = sqrt(${a * a} + ${b * b}) = sqrt(${c * c}) = ${c}.`,
        ...buildChoices(rng, fmt(c), [
          fmt(a + b),                // added instead of using the theorem
          fmt(Math.abs(b - a)),
          fmt(c * 2),
        ], numericFallback(c)),
      };
    },
  },
  {
    idPrefix: 'gen-math-mid', subject: 'Math', topic: 'Coordinate Geometry', difficulty: 'easy',
    build(rng) {
      const mx = randInt(rng, -8, 8);
      const my = randInt(rng, -8, 8);
      const dx = randInt(rng, 1, 7);
      const dy = randInt(rng, 1, 7);
      const x1 = mx - dx; const x2 = mx + dx;
      const y1 = my - dy; const y2 = my + dy;
      return {
        prompt: `What is the midpoint of the segment joining (${x1}, ${y1}) and (${x2}, ${y2})?`,
        explanation: `Midpoint = ((${x1} + ${x2})/2, (${y1} + ${y2})/2) = (${mx}, ${my}).`,
        ...buildChoices(rng, `(${mx}, ${my})`, [
          `(${x2 - x1}, ${y2 - y1})`,    // computed the difference
          `(${mx + dx}, ${my + dy})`,
          `(${my}, ${mx})`,              // swapped coordinates
        ], (i) => `(${mx + i + 1}, ${my - i - 1})`),
      };
    },
  },

  // ------------------------------------------------------------- functions
  {
    idPrefix: 'gen-math-fn1', subject: 'Math', topic: 'Functions', difficulty: 'medium',
    build(rng) {
      const a = randInt(rng, 2, 5);
      const c = randNonZero(rng, -9, 9);
      const x = randInt(rng, -5, -1);
      const value = a * x * x + c;
      return {
        prompt: `If f(x) = ${a}x^2 ${signed(c)}, what is f(${x})?`,
        explanation: `f(${x}) = ${a}(${x})^2 ${signed(c)} = ${a}(${x * x}) ${signed(c)} = ${value}. Squaring removes the negative before multiplying.`,
        ...buildChoices(rng, fmt(value), [
          fmt(-a * x * x + c),      // let the negative survive the square
          fmt(a * x + c),           // forgot to square
          fmt(-value),
        ], numericFallback(value)),
      };
    },
  },
  {
    idPrefix: 'gen-math-fn2', subject: 'Math', topic: 'Functions', difficulty: 'hard',
    build(rng) {
      const a = randInt(rng, 2, 5);
      const b = randNonZero(rng, -7, 7);
      const x = randInt(rng, 2, 5);
      const inner = x * x;
      const value = a * inner + b;
      const wrongOrder = Math.pow(a * x + b, 2);
      return {
        prompt: `If f(x) = ${a}x ${signed(b)} and g(x) = x^2, what is f(g(${x}))?`,
        explanation: `Work inside out: g(${x}) = ${inner}, then f(${inner}) = ${a}(${inner}) ${signed(b)} = ${value}. Applying them in the wrong order gives ${wrongOrder}.`,
        ...buildChoices(rng, fmt(value), [
          fmt(wrongOrder),         // composed in the wrong order
          fmt(a * x + b),          // never applied g
          fmt(inner),
        ], numericFallback(value)),
      };
    },
  },

  // ------------------------------------------------- ratios and percentages
  {
    idPrefix: 'gen-math-ratio', subject: 'Math', topic: 'Ratios and Proportions', difficulty: 'easy',
    build(rng) {
      const p = randInt(rng, 1, 6);
      const q = randInt(rng, p + 1, 9);
      const unit = randInt(rng, 2, 9);
      const total = (p + q) * unit;
      return {
        prompt: `Two numbers are in the ratio ${p}:${q} and add up to ${total}. What is the larger number?`,
        explanation: `There are ${p} + ${q} = ${p + q} parts, so each part is ${total}/${p + q} = ${unit}. The larger number is ${q} x ${unit} = ${q * unit}.`,
        ...buildChoices(rng, fmt(q * unit), [
          fmt(p * unit),        // gave the smaller number
          fmt(total / 2),       // split evenly
          fmt(unit),
        ], numericFallback(q * unit)),
      };
    },
  },
  {
    idPrefix: 'gen-math-pct1', subject: 'Math', topic: 'Percentages', difficulty: 'medium',
    build(rng) {
      const price = pick(rng, [20, 40, 50, 60, 80, 100, 120, 200]);
      const d1 = pick(rng, [10, 20, 25, 50]);
      const d2 = pick(rng, [10, 20, 25]);
      const final = price * (1 - d1 / 100) * (1 - d2 / 100);
      const naive = price * (1 - (d1 + d2) / 100);
      if (final === naive) return null;
      return {
        prompt: `An item costs $${price}. It is marked down ${d1}%, and then an additional ${d2}% is taken off the sale price. What is the final price?`,
        explanation: `${price} x ${fmt(1 - d1 / 100)} = ${fmt(price * (1 - d1 / 100))}, then x ${fmt(1 - d2 / 100)} = ${fmt(final)}. Successive discounts multiply; they do not add to ${d1 + d2}%.`,
        ...buildChoices(rng, `$${fmt(final)}`, [
          `$${fmt(naive)}`,      // added the percentages
          `$${fmt(price - d1 - d2)}`,
          `$${fmt(price * (1 - d1 / 100))}`,   // stopped after the first discount
        ], (i) => `$${fmt(final + (i + 1) * 2)}`),
      };
    },
  },
  {
    idPrefix: 'gen-math-pct2', subject: 'Math', topic: 'Percentages', difficulty: 'hard',
    build(rng) {
      const original = pick(rng, [40, 50, 60, 80, 120, 150, 200, 250]);
      const pctChange = pick(rng, [10, 20, 25, 50]);
      const result = original * (1 + pctChange / 100);
      return {
        prompt: `After a ${pctChange}% increase, a number becomes ${fmt(result)}. What was the original number?`,
        explanation: `If n is the original, then ${fmt(1 + pctChange / 100)}n = ${fmt(result)}, so n = ${fmt(result)}/${fmt(1 + pctChange / 100)} = ${original}. Subtracting ${pctChange}% from ${fmt(result)} gives ${fmt(result * (1 - pctChange / 100))}, which is the trap.`,
        ...buildChoices(rng, fmt(original), [
          fmt(result * (1 - pctChange / 100)),   // subtracted the percentage instead
          fmt(result - pctChange),
          fmt(result),
        ], numericFallback(original)),
      };
    },
  },
  {
    idPrefix: 'gen-math-pct3', subject: 'Math', topic: 'Percentages', difficulty: 'easy',
    build(rng) {
      const whole = pick(rng, [20, 25, 40, 50, 60, 80, 120, 200, 300]);
      const pct = pick(rng, [5, 10, 15, 20, 25, 30, 40, 60, 75]);
      const part = (whole * pct) / 100;
      return {
        prompt: `What is ${pct}% of ${whole}?`,
        explanation: `${pct}% of ${whole} = ${fmt(pct / 100)} x ${whole} = ${fmt(part)}.`,
        ...buildChoices(rng, fmt(part), [
          fmt(whole / pct),
          fmt(part * 10),
          fmt(whole - part),
        ], numericFallback(part)),
      };
    },
  },

  // ------------------------------------------------------------ statistics
  {
    idPrefix: 'gen-math-mean', subject: 'Math', topic: 'Statistics', difficulty: 'medium',
    build(rng) {
      const n = randInt(rng, 4, 6);
      const values = [];
      for (let i = 0; i < n; i++) values.push(randInt(rng, 1, 30));
      const sum = values.reduce((s, v) => s + v, 0);
      const mean = sum / n;
      const sorted = [...values].sort((a, b) => a - b);
      const median = n % 2 === 1
        ? sorted[(n - 1) / 2]
        : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
      if (mean === median) return null;
      return {
        prompt: `What is the mean of the set {${values.join(', ')}}?`,
        explanation: `The sum is ${sum} and there are ${n} values, so the mean is ${sum}/${n} = ${fmt(mean)}. (${fmt(median)} is the median, a common mix-up.)`,
        ...buildChoices(rng, fmt(mean), [
          fmt(median),        // gave the median
          fmt(sum),
          fmt(Math.max(...values) - Math.min(...values)),  // gave the range
        ], numericFallback(mean)),
      };
    },
  },
  {
    idPrefix: 'gen-math-median', subject: 'Math', topic: 'Statistics', difficulty: 'medium',
    build(rng) {
      const n = pick(rng, [5, 7]);
      const values = [];
      for (let i = 0; i < n; i++) values.push(randInt(rng, 1, 40));
      const sorted = [...values].sort((a, b) => a - b);
      const median = sorted[(n - 1) / 2];
      const mean = values.reduce((s, v) => s + v, 0) / n;
      if (median === mean) return null;
      return {
        prompt: `What is the median of the set {${values.join(', ')}}?`,
        explanation: `Sorted, the set is {${sorted.join(', ')}}. With ${n} values the middle one is ${median}.`,
        ...buildChoices(rng, fmt(median), [
          fmt(mean),
          fmt(values[Math.floor(n / 2)]),    // took the middle of the UNSORTED list
          fmt(Math.max(...values)),
        ], numericFallback(median)),
      };
    },
  },
  {
    idPrefix: 'gen-math-range', subject: 'Math', topic: 'Statistics', difficulty: 'easy',
    build(rng) {
      const n = randInt(rng, 4, 6);
      const values = [];
      for (let i = 0; i < n; i++) values.push(randInt(rng, 1, 50));
      const range = Math.max(...values) - Math.min(...values);
      if (range === 0) return null;
      return {
        prompt: `What is the range of the set {${values.join(', ')}}?`,
        explanation: `Range = largest minus smallest = ${Math.max(...values)} - ${Math.min(...values)} = ${range}.`,
        ...buildChoices(rng, fmt(range), [
          fmt(Math.max(...values)),
          fmt(Math.min(...values)),
          fmt(values.reduce((s, v) => s + v, 0) / n),
        ], numericFallback(range)),
      };
    },
  },

  // ----------------------------------------------------------- word problems
  {
    idPrefix: 'gen-math-rate', subject: 'Math', topic: 'Rates and Word Problems', difficulty: 'medium',
    build(rng) {
      const speed = pick(rng, [15, 20, 25, 30, 40, 45, 50, 60]);
      const hours = randInt(rng, 2, 8);
      const distance = speed * hours;
      return {
        prompt: `A cyclist travels ${distance} miles in ${hours} hours at a constant speed. What is the speed in miles per hour?`,
        explanation: `Speed = distance / time = ${distance} / ${hours} = ${speed} miles per hour.`,
        ...buildChoices(rng, fmt(speed), [
          fmt(distance * hours),
          fmt(hours / distance),      // inverted the formula
          fmt(distance - hours),
        ], numericFallback(speed)),
      };
    },
  },
  {
    idPrefix: 'gen-math-work', subject: 'Math', topic: 'Rates and Word Problems', difficulty: 'hard',
    build(rng) {
      const perHour = randInt(rng, 3, 12);
      const workers = randInt(rng, 2, 6);
      const hours = randInt(rng, 2, 8);
      const total = perHour * workers * hours;
      return {
        prompt: `Each worker assembles ${perHour} units per hour. How many units do ${workers} workers assemble in ${hours} hours?`,
        explanation: `${perHour} units/hour x ${workers} workers = ${perHour * workers} units per hour for the team, and over ${hours} hours that is ${total} units.`,
        ...buildChoices(rng, fmt(total), [
          fmt(perHour * workers),     // forgot the hours
          fmt(perHour * hours),       // forgot the workers
          fmt(perHour + workers + hours),
        ], numericFallback(total)),
      };
    },
  },
];

module.exports = templates;
