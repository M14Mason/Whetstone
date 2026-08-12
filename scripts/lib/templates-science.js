'use strict';

const { randInt, pick, fmt, buildChoices, numericFallback } = require('./generator-core');

/**
 * Quantitative science templates: physics, chemistry, and genetics problems
 * whose answers are computed rather than typed.
 *
 * Conceptual science (why mitochondria matter, what a covalent bond is) stays
 * hand-written in data/questions.science.json, because those cannot be
 * parameterised without becoming nonsense.
 */

const MOLAR_MASSES = [
  { formula: 'H2O', name: 'water', mass: 18 },
  { formula: 'CO2', name: 'carbon dioxide', mass: 44 },
  { formula: 'NaCl', name: 'sodium chloride', mass: 58.5 },
  { formula: 'O2', name: 'oxygen gas', mass: 32 },
  { formula: 'CH4', name: 'methane', mass: 16 },
  { formula: 'NH3', name: 'ammonia', mass: 17 },
  { formula: 'C6H12O6', name: 'glucose', mass: 180 },
  { formula: 'H2', name: 'hydrogen gas', mass: 2 },
];

const templates = [
  // ----------------------------------------------------------- Newton's laws
  {
    idPrefix: 'gen-sci-force', subject: 'Science', topic: "Newton's Laws", difficulty: 'easy',
    build(rng) {
      const mass = pick(rng, [2, 4, 5, 8, 10, 12, 15, 20, 25, 50]);
      const accel = pick(rng, [2, 3, 4, 5, 6, 8, 10]);
      const force = mass * accel;
      return {
        prompt: `A ${mass} kg object accelerates at ${accel} m/s^2. What net force acts on it?`,
        explanation: `F = ma = ${mass} kg x ${accel} m/s^2 = ${force} N.`,
        ...buildChoices(rng, `${fmt(force)} N`, [
          `${fmt(mass / accel)} N`,      // divided instead of multiplied
          `${fmt(mass + accel)} N`,
          `${fmt(force / 2)} N`,
        ], (i) => `${fmt(force + (i + 1) * 5)} N`),
      };
    },
  },
  {
    idPrefix: 'gen-sci-accel', subject: 'Science', topic: "Newton's Laws", difficulty: 'medium',
    build(rng) {
      const mass = pick(rng, [2, 4, 5, 8, 10, 20, 25]);
      const accel = pick(rng, [2, 3, 4, 5, 6]);
      const force = mass * accel;
      return {
        prompt: `A net force of ${force} N acts on a ${mass} kg object. What is its acceleration?`,
        explanation: `Rearranging F = ma gives a = F/m = ${force} / ${mass} = ${accel} m/s^2.`,
        ...buildChoices(rng, `${fmt(accel)} m/s^2`, [
          `${fmt(force * mass)} m/s^2`,     // multiplied instead of divided
          `${fmt(mass / force)} m/s^2`,     // inverted the fraction
          `${fmt(force - mass)} m/s^2`,
        ], (i) => `${fmt(accel + i + 1)} m/s^2`),
      };
    },
  },
  {
    idPrefix: 'gen-sci-weight', subject: 'Science', topic: "Newton's Laws", difficulty: 'medium',
    build(rng) {
      const mass = pick(rng, [2, 5, 10, 15, 20, 40, 50]);
      const g = 10;
      const weight = mass * g;
      return {
        prompt: `Using g = 10 m/s^2, what is the weight of a ${mass} kg object on Earth?`,
        explanation: `Weight is a force: W = mg = ${mass} x 10 = ${weight} N. Mass in kilograms and weight in newtons are different quantities.`,
        ...buildChoices(rng, `${fmt(weight)} N`, [
          `${fmt(mass)} N`,          // confused mass with weight
          `${fmt(weight / 10)} N`,
          `${fmt(mass * 9.8 * 2)} N`,
        ], (i) => `${fmt(weight + (i + 1) * 10)} N`),
      };
    },
  },

  // ------------------------------------------------------------------ energy
  {
    idPrefix: 'gen-sci-ke', subject: 'Science', topic: 'Energy', difficulty: 'medium',
    build(rng) {
      const mass = pick(rng, [2, 4, 6, 8, 10, 12, 20]);
      const v = pick(rng, [2, 3, 4, 5, 6, 10]);
      const ke = 0.5 * mass * v * v;
      return {
        prompt: `What is the kinetic energy of a ${mass} kg object moving at ${v} m/s?`,
        explanation: `KE = (1/2)mv^2 = 0.5 x ${mass} x ${v * v} = ${fmt(ke)} J. Forgetting to square the velocity gives ${fmt(0.5 * mass * v)} J.`,
        ...buildChoices(rng, `${fmt(ke)} J`, [
          `${fmt(0.5 * mass * v)} J`,   // did not square v
          `${fmt(mass * v * v)} J`,     // dropped the one half
          `${fmt(mass * v)} J`,
        ], (i) => `${fmt(ke + (i + 1) * 4)} J`),
      };
    },
  },
  {
    idPrefix: 'gen-sci-pe', subject: 'Science', topic: 'Energy', difficulty: 'medium',
    build(rng) {
      const mass = pick(rng, [2, 3, 5, 8, 10, 15, 20]);
      const height = pick(rng, [2, 3, 4, 5, 10, 12, 20]);
      const pe = mass * 10 * height;
      return {
        prompt: `Using g = 10 m/s^2, what is the gravitational potential energy of a ${mass} kg object at a height of ${height} m?`,
        explanation: `PE = mgh = ${mass} x 10 x ${height} = ${fmt(pe)} J.`,
        ...buildChoices(rng, `${fmt(pe)} J`, [
          `${fmt(mass * height)} J`,      // forgot g
          `${fmt(pe / 2)} J`,             // used the KE one-half by mistake
          `${fmt(mass + height)} J`,
        ], (i) => `${fmt(pe + (i + 1) * 20)} J`),
      };
    },
  },

  // ------------------------------------------------------------------- waves
  {
    idPrefix: 'gen-sci-wave1', subject: 'Science', topic: 'Waves', difficulty: 'medium',
    build(rng) {
      const f = pick(rng, [2, 3, 4, 5, 6, 8, 10, 12, 20]);
      const lambda = pick(rng, [0.5, 2, 3, 4, 5, 10]);
      const v = f * lambda;
      return {
        prompt: `A wave has a frequency of ${f} Hz and a wavelength of ${lambda} m. What is its speed?`,
        explanation: `v = f x lambda = ${f} x ${lambda} = ${fmt(v)} m/s.`,
        ...buildChoices(rng, `${fmt(v)} m/s`, [
          `${fmt(f / lambda)} m/s`,     // divided instead of multiplied
          `${fmt(f + lambda)} m/s`,
          `${fmt(lambda / f)} m/s`,
        ], (i) => `${fmt(v + (i + 1) * 3)} m/s`),
      };
    },
  },
  {
    idPrefix: 'gen-sci-wave2', subject: 'Science', topic: 'Waves', difficulty: 'hard',
    build(rng) {
      const f = pick(rng, [2, 4, 5, 8, 10, 20, 25]);
      const lambda = pick(rng, [2, 4, 5, 10]);
      const v = f * lambda;
      return {
        prompt: `A wave travels at ${fmt(v)} m/s with a frequency of ${f} Hz. What is its wavelength?`,
        explanation: `Rearranging v = f x lambda gives lambda = v/f = ${fmt(v)} / ${f} = ${fmt(lambda)} m.`,
        ...buildChoices(rng, `${fmt(lambda)} m`, [
          `${fmt(v * f)} m`,        // multiplied instead of divided
          `${fmt(f / v)} m`,        // inverted
          `${fmt(v - f)} m`,
        ], (i) => `${fmt(lambda + i + 1)} m`),
      };
    },
  },

  // --------------------------------------------------------------- chemistry
  {
    idPrefix: 'gen-sci-moles1', subject: 'Science', topic: 'Stoichiometry', difficulty: 'medium',
    build(rng) {
      const compound = pick(rng, MOLAR_MASSES);
      const moles = pick(rng, [0.5, 2, 3, 4, 5, 10]);
      const mass = compound.mass * moles;
      return {
        prompt: `How many moles are in ${fmt(mass)} grams of ${compound.name} (${compound.formula}, molar mass ${fmt(compound.mass)} g/mol)?`,
        explanation: `Moles = mass / molar mass = ${fmt(mass)} / ${fmt(compound.mass)} = ${fmt(moles)} mol.`,
        ...buildChoices(rng, `${fmt(moles)} mol`, [
          `${fmt(mass * compound.mass)} mol`,   // multiplied instead of divided
          `${fmt(compound.mass / mass)} mol`,   // inverted
          `${fmt(mass)} mol`,
        ], (i) => `${fmt(moles + i + 1)} mol`),
      };
    },
  },
  {
    idPrefix: 'gen-sci-moles2', subject: 'Science', topic: 'Stoichiometry', difficulty: 'medium',
    build(rng) {
      const compound = pick(rng, MOLAR_MASSES);
      const moles = pick(rng, [2, 3, 4, 5, 0.5]);
      const mass = compound.mass * moles;
      return {
        prompt: `What is the mass of ${fmt(moles)} moles of ${compound.name} (${compound.formula}, molar mass ${fmt(compound.mass)} g/mol)?`,
        explanation: `Mass = moles x molar mass = ${fmt(moles)} x ${fmt(compound.mass)} = ${fmt(mass)} g.`,
        ...buildChoices(rng, `${fmt(mass)} g`, [
          `${fmt(compound.mass / moles)} g`,    // divided instead of multiplied
          `${fmt(compound.mass)} g`,            // gave the molar mass
          `${fmt(moles)} g`,
        ], (i) => `${fmt(mass + (i + 1) * 6)} g`),
      };
    },
  },
  {
    idPrefix: 'gen-sci-stoich', subject: 'Science', topic: 'Stoichiometry', difficulty: 'hard',
    build(rng) {
      const reactions = [
        { eq: '2H2 + O2 -> 2H2O', from: 'H2', to: 'O2', ratio: 0.5 },
        { eq: '2H2 + O2 -> 2H2O', from: 'O2', to: 'H2O', ratio: 2 },
        { eq: 'N2 + 3H2 -> 2NH3', from: 'N2', to: 'H2', ratio: 3 },
        { eq: 'N2 + 3H2 -> 2NH3', from: 'N2', to: 'NH3', ratio: 2 },
        { eq: '2Na + Cl2 -> 2NaCl', from: 'Na', to: 'NaCl', ratio: 1 },
        { eq: 'CH4 + 2O2 -> CO2 + 2H2O', from: 'CH4', to: 'O2', ratio: 2 },
      ];
      const r = pick(rng, reactions);
      const input = pick(rng, [2, 4, 6, 8, 10]);
      const output = input * r.ratio;
      return {
        prompt: `For the reaction ${r.eq}, how many moles of ${r.to} are involved when ${input} moles of ${r.from} react completely?`,
        explanation: `The balanced coefficients set the mole ratio of ${r.from} to ${r.to}. Multiplying ${input} mol by ${fmt(r.ratio)} gives ${fmt(output)} mol of ${r.to}.`,
        ...buildChoices(rng, `${fmt(output)} mol`, [
          `${fmt(input)} mol`,                 // assumed a one-to-one ratio
          `${fmt(input / r.ratio)} mol`,       // inverted the ratio
          `${fmt(input * 2 * r.ratio)} mol`,
        ], (i) => `${fmt(output + i + 1)} mol`),
      };
    },
  },
  {
    idPrefix: 'gen-sci-density', subject: 'Science', topic: 'Density', difficulty: 'easy',
    build(rng) {
      const density = pick(rng, [2, 2.5, 4, 5, 8, 10]);
      const volume = pick(rng, [2, 4, 5, 10, 20]);
      const mass = density * volume;
      return {
        prompt: `An object has a mass of ${fmt(mass)} g and a volume of ${volume} cm^3. What is its density?`,
        explanation: `Density = mass / volume = ${fmt(mass)} / ${volume} = ${fmt(density)} g/cm^3.`,
        ...buildChoices(rng, `${fmt(density)} g/cm^3`, [
          `${fmt(volume / mass)} g/cm^3`,   // inverted
          `${fmt(mass * volume)} g/cm^3`,
          `${fmt(mass - volume)} g/cm^3`,
        ], (i) => `${fmt(density + i + 1)} g/cm^3`),
      };
    },
  },

  // ------------------------------------------------------------ electricity
  {
    idPrefix: 'gen-sci-ohm1', subject: 'Science', topic: 'Electricity', difficulty: 'medium',
    build(rng) {
      const current = pick(rng, [2, 3, 4, 5, 0.5]);
      const resistance = pick(rng, [4, 6, 8, 10, 12, 20, 50]);
      const voltage = current * resistance;
      return {
        prompt: `A current of ${fmt(current)} A flows through a ${resistance} ohm resistor. What is the voltage across it?`,
        explanation: `Ohm's law: V = IR = ${fmt(current)} x ${resistance} = ${fmt(voltage)} V.`,
        ...buildChoices(rng, `${fmt(voltage)} V`, [
          `${fmt(resistance / current)} V`,   // divided instead of multiplied
          `${fmt(current / resistance)} V`,
          `${fmt(current + resistance)} V`,
        ], (i) => `${fmt(voltage + (i + 1) * 4)} V`),
      };
    },
  },
  {
    idPrefix: 'gen-sci-ohm2', subject: 'Science', topic: 'Electricity', difficulty: 'hard',
    build(rng) {
      const current = pick(rng, [2, 3, 4, 5]);
      const resistance = pick(rng, [4, 6, 8, 10, 12, 20]);
      const voltage = current * resistance;
      return {
        prompt: `A ${fmt(voltage)} V battery drives ${fmt(current)} A through a circuit. What is the resistance?`,
        explanation: `Rearranging V = IR gives R = V/I = ${fmt(voltage)} / ${fmt(current)} = ${resistance} ohms.`,
        ...buildChoices(rng, `${resistance} ohms`, [
          `${fmt(voltage * current)} ohms`,   // multiplied instead of divided
          `${fmt(current / voltage)} ohms`,
          `${fmt(voltage - current)} ohms`,
        ], (i) => `${fmt(resistance + (i + 1) * 2)} ohms`),
      };
    },
  },

  // --------------------------------------------------------------- kinematics
  {
    idPrefix: 'gen-sci-speed', subject: 'Science', topic: 'Motion', difficulty: 'easy',
    build(rng) {
      const speed = pick(rng, [2, 4, 5, 8, 10, 15, 20, 25]);
      const time = pick(rng, [2, 3, 4, 5, 6, 10]);
      const distance = speed * time;
      return {
        prompt: `An object travels ${distance} m in ${time} s at a constant speed. What is its speed?`,
        explanation: `Speed = distance / time = ${distance} / ${time} = ${speed} m/s.`,
        ...buildChoices(rng, `${fmt(speed)} m/s`, [
          `${fmt(distance * time)} m/s`,
          `${fmt(time / distance)} m/s`,
          `${fmt(distance - time)} m/s`,
        ], (i) => `${fmt(speed + i + 1)} m/s`),
      };
    },
  },
  {
    idPrefix: 'gen-sci-accel2', subject: 'Science', topic: 'Motion', difficulty: 'medium',
    build(rng) {
      const vi = pick(rng, [0, 2, 5, 10]);
      const accel = pick(rng, [2, 3, 4, 5]);
      const time = pick(rng, [2, 3, 4, 5, 6]);
      const vf = vi + accel * time;
      return {
        prompt: `An object starts at ${vi} m/s and accelerates at ${accel} m/s^2 for ${time} s. What is its final velocity?`,
        explanation: `v = v0 + at = ${vi} + ${accel} x ${time} = ${vf} m/s.`,
        ...buildChoices(rng, `${fmt(vf)} m/s`, [
          `${fmt(accel * time)} m/s`,      // ignored the initial velocity
          `${fmt(vi + accel)} m/s`,        // forgot to multiply by time
          `${fmt(vi * accel * time)} m/s`,
        ], (i) => `${fmt(vf + i + 1)} m/s`),
      };
    },
  },

  // ----------------------------------------------------------------- genetics
  {
    idPrefix: 'gen-sci-punnett', subject: 'Science', topic: 'Genetics', difficulty: 'medium',
    build(rng) {
      const crosses = [
        { p1: 'Aa', p2: 'Aa', recessive: 25, hetero: 50, dominantPheno: 75 },
        { p1: 'Aa', p2: 'aa', recessive: 50, hetero: 50, dominantPheno: 50 },
        { p1: 'AA', p2: 'aa', recessive: 0, hetero: 100, dominantPheno: 100 },
        { p1: 'AA', p2: 'Aa', recessive: 0, hetero: 50, dominantPheno: 100 },
      ];
      const cross = pick(rng, crosses);
      const asked = pick(rng, ['recessive', 'hetero', 'dominantPheno']);
      const labels = {
        recessive: 'homozygous recessive (aa)',
        hetero: 'heterozygous (Aa)',
        dominantPheno: 'showing the dominant phenotype',
      };
      const value = cross[asked];
      const others = ['recessive', 'hetero', 'dominantPheno']
        .filter((k) => k !== asked)
        .map((k) => `${cross[k]}%`);
      return {
        prompt: `In a cross between ${cross.p1} and ${cross.p2} (A is completely dominant), what percentage of offspring are expected to be ${labels[asked]}?`,
        explanation: `Draw the Punnett square for ${cross.p1} x ${cross.p2}. The proportion ${labels[asked]} is ${value}%.`,
        ...buildChoices(rng, `${value}%`, [...others, '0%', '100%'],
          (i) => `${[10, 33, 66, 90, 20, 80][i % 6]}%`),
      };
    },
  },
  {
    idPrefix: 'gen-sci-halflife', subject: 'Science', topic: 'Radioactivity', difficulty: 'hard',
    build(rng) {
      const initial = pick(rng, [80, 100, 160, 200, 320, 400, 800]);
      const halfLife = pick(rng, [2, 5, 10, 20]);
      const periods = randInt(rng, 2, 4);
      const elapsed = halfLife * periods;
      const remaining = initial / Math.pow(2, periods);
      return {
        prompt: `A sample of ${initial} g has a half-life of ${halfLife} years. How much remains after ${elapsed} years?`,
        explanation: `${elapsed} years is ${periods} half-lives. Each halves the sample: ${initial} / 2^${periods} = ${fmt(remaining)} g.`,
        ...buildChoices(rng, `${fmt(remaining)} g`, [
          `${fmt(initial / periods)} g`,          // divided by the count instead of halving
          `${fmt(initial / 2)} g`,                // only applied one half-life
          `${fmt(initial - periods * halfLife)} g`,
        ], (i) => `${fmt(remaining + (i + 1) * 5)} g`),
      };
    },
  },
];

module.exports = templates;
