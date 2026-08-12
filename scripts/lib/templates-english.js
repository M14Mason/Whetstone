'use strict';

const { pick, buildChoices } = require('./generator-core');

/**
 * English templates.
 *
 * Grammar rules are fixed but the sentences they apply to are not, so these
 * templates vary the sentence from word banks rather than varying numbers. That
 * matters pedagogically: a student who has only seen "The list of items IS"
 * often cannot transfer the rule to "The box of nails IS". Same rule, different
 * surface, which is exactly what the adaptive engine needs to test mastery
 * rather than memorisation of one example.
 */

// Singular collective noun + plural prepositional object. The verb must agree
// with the collective noun, never the object of the preposition.
const SINGULAR_HEADS = [
  ['list', 'required items'], ['box', 'old nails'], ['bag', 'mixed nuts'],
  ['stack', 'graded papers'], ['bundle', 'dry sticks'], ['collection', 'rare coins'],
  ['crate', 'ripe oranges'], ['folder', 'tax documents'], ['set', 'kitchen knives'],
  ['bouquet', 'white roses'], ['shipment', 'new laptops'], ['series', 'hard questions'],
  ['pile', 'wet leaves'], ['carton', 'brown eggs'], ['row', 'empty seats'],
];

const PAIRED_SUBJECTS = [
  ['coach', 'players'], ['teacher', 'students'], ['manager', 'employees'],
  ['director', 'actors'], ['captain', 'sailors'], ['author', 'editors'],
  ['chef', 'servers'], ['principal', 'parents'], ['pilot', 'passengers'],
  ['conductor', 'musicians'],
];

const GROUP_NOUNS = [
  'students', 'players', 'volunteers', 'employees', 'researchers',
  'candidates', 'travellers', 'musicians', 'engineers', 'applicants',
];

const NAME_PAIRS = [
  ['Maria', 'Jenna'], ['Devon', 'Chris'], ['Priya', 'Sam'], ['Noah', 'Eli'],
  ['Aisha', 'Rosa'], ['Kai', 'Jordan'], ['Lena', 'Mika'], ['Omar', 'Tariq'],
];

const INTRO_CLAUSES = [
  ['After the storm passed', 'we went outside'],
  ['Before the concert began', 'the crowd fell silent'],
  ['Because the road was flooded', 'the bus took a detour'],
  ['Although she was exhausted', 'she finished the race'],
  ['When the power returned', 'the lights flickered on'],
  ['While the bread was baking', 'he cleaned the kitchen'],
  ['Since nobody objected', 'the motion passed'],
  ['If the weather holds', 'the game will go ahead'],
  ['Once the results arrived', 'the team celebrated'],
  ['As the sun set', 'the temperature dropped'],
];

const NONESSENTIAL = [
  ['My brother', 'who lives in Ohio', 'is visiting next week'],
  ['Our neighbour', 'who restores old cars', 'offered to help'],
  ['The professor', 'who wrote the textbook', 'is retiring in June'],
  ['My cousin', 'who studies marine biology', 'sent me photographs'],
  ['The librarian', 'who runs the reading club', 'ordered new copies'],
  ['Her uncle', 'who trained as a pilot', 'tells the best stories'],
  ['The mechanic', 'who fixed our brakes', 'charged us nothing'],
  ['My roommate', 'who works night shifts', 'sleeps until noon'],
];

const INDEPENDENT_PAIRS = [
  ['The rain stopped', 'the game continued'],
  ['The lights went out', 'the audience gasped'],
  ['She finished the draft', 'her editor approved it'],
  ['The train was late', 'nobody complained'],
  ['The data looked clean', 'the conclusion held up'],
  ['He missed the bus', 'he walked instead'],
  ['The market closed early', 'traders went home'],
  ['The evidence was thin', 'the case collapsed'],
];

const GERUND_TRIPLES = [
  ['swimming', 'hiking', 'biking', 'to bike'],
  ['reading', 'writing', 'drawing', 'to draw'],
  ['cooking', 'baking', 'gardening', 'to garden'],
  ['running', 'cycling', 'rowing', 'to row'],
  ['painting', 'sculpting', 'sketching', 'to sketch'],
  ['singing', 'dancing', 'acting', 'to act'],
  ['coding', 'debugging', 'testing', 'to test'],
];

const DANGLERS = [
  ['Running late for school', 'Tom', 'the bus was missed by Tom', 'Tom missed the bus'],
  ['Covered in mud', 'the dog', 'the bath was needed by the dog', 'the dog needed a bath'],
  ['Exhausted after the hike', 'Ana', 'the tent was hard for Ana to pitch', 'Ana struggled to pitch the tent'],
  ['Having studied all night', 'Rae', 'the exam felt easy to Rae', 'Rae found the exam easy'],
  ['Startled by the noise', 'the cat', 'the shelf was knocked over by the cat', 'the cat knocked over the shelf'],
];

const POSSESSIVE_NOUNS = [
  ['students', 'books'], ['teachers', 'lounge'], ['players', 'uniforms'],
  ['workers', 'wages'], ['dogs', 'leashes'], ['neighbours', 'fence'],
  ['musicians', 'instruments'], ['clients', 'files'], ['drivers', 'licences'],
];

const templates = [
  {
    idPrefix: 'gen-eng-sva1', subject: 'English', topic: 'Subject-Verb Agreement', difficulty: 'easy',
    build(rng) {
      const [head, object] = pick(rng, SINGULAR_HEADS);
      return {
        prompt: `Choose the correct verb:  The ${head} of ${object} ____ on the table.`,
        explanation: `The subject is "${head}" (singular), not "${object}". A prepositional phrase like "of ${object}" never contains the subject, so the verb stays singular: "is".`,
        ...buildChoices(rng, 'is', ['are', 'were', 'have been'], () => 'be'),
      };
    },
  },
  {
    idPrefix: 'gen-eng-sva2', subject: 'English', topic: 'Subject-Verb Agreement', difficulty: 'medium',
    build(rng) {
      const [singular, plural] = pick(rng, PAIRED_SUBJECTS);
      return {
        prompt: `Choose the correct verb:  Neither the ${singular} nor the ${plural} ____ satisfied with the result.`,
        explanation: `With "neither/nor" the verb agrees with the subject closest to it. "${plural}" is plural and sits nearest the verb, so "are" is correct.`,
        ...buildChoices(rng, 'are', ['is', 'was', 'has been'], () => 'being'),
      };
    },
  },
  {
    idPrefix: 'gen-eng-sva3', subject: 'English', topic: 'Subject-Verb Agreement', difficulty: 'hard',
    build(rng) {
      const noun = pick(rng, GROUP_NOUNS);
      const quantifier = pick(rng, ['Each', 'Every one', 'Neither']);
      return {
        prompt: `Choose the correct verb:  ${quantifier} of the ${noun} ____ submitted the form.`,
        explanation: `"${quantifier}" is always singular, regardless of the plural noun that follows, so the singular "has" is correct.`,
        ...buildChoices(rng, 'has', ['have', 'are', 'were'], () => 'having'),
      };
    },
  },
  {
    idPrefix: 'gen-eng-pro1', subject: 'English', topic: 'Pronoun Clarity', difficulty: 'medium',
    build(rng) {
      const [a, b] = pick(rng, NAME_PAIRS);
      return {
        prompt: `What is the problem with this sentence?  When ${a} met ${b}, she was nervous about the interview.`,
        explanation: `"She" could refer to ${a} or to ${b}. When a pronoun has two possible antecedents the sentence is ambiguous and must name the person instead.`,
        ...buildChoices(rng, 'The pronoun "she" is ambiguous', [
          'The verb tense is inconsistent',
          'There is a comma splice',
          'The sentence is a fragment',
        ], () => 'The sentence is passive'),
      };
    },
  },
  {
    idPrefix: 'gen-eng-pro2', subject: 'English', topic: 'Pronoun Clarity', difficulty: 'hard',
    build(rng) {
      const [name] = pick(rng, NAME_PAIRS);
      const preposition = pick(rng, ['to', 'for', 'between you and', 'with']);
      return {
        prompt: `Choose the correct pronoun:  The award was given ${preposition} ${name} and ____.`,
        explanation: `The pronoun is the object of "${preposition}", so the objective case "me" is correct. Drop "${name} and" and the right choice becomes obvious: "given ${preposition} me".`,
        ...buildChoices(rng, 'me', ['I', 'myself', 'mine'], () => 'my'),
      };
    },
  },
  {
    idPrefix: 'gen-eng-whom', subject: 'English', topic: 'Pronoun Clarity', difficulty: 'hard',
    build(rng) {
      const role = pick(rng, ['scientist', 'candidate', 'author', 'engineer', 'artist', 'journalist', 'coach', 'architect']);
      const actor = pick(rng, ['the committee', 'the board', 'the panel', 'the jury', 'the editors']);
      return {
        prompt: `Choose the correct word:  The ${role} ____ ${actor} selected has published widely.`,
        explanation: `${actor.charAt(0).toUpperCase() + actor.slice(1)} selected the ${role}, so the pronoun is the OBJECT of the verb. Objects take "whom"; subjects take "who".`,
        ...buildChoices(rng, 'whom', ['who', 'which', 'whose'], () => 'that whom'),
      };
    },
  },
  {
    idPrefix: 'gen-eng-comma1', subject: 'English', topic: 'Comma Usage', difficulty: 'easy',
    build(rng) {
      const [intro, main] = pick(rng, INTRO_CLAUSES);
      return {
        prompt: `Which sentence is punctuated correctly?`,
        explanation: `An introductory dependent clause takes a comma before the main clause: "${intro}, ${main}."`,
        ...buildChoices(rng, `${intro}, ${main}.`, [
          `${intro} ${main}.`,
          `${intro.split(' ')[0]}, ${intro.split(' ').slice(1).join(' ')} ${main}.`,
          `${intro}, ${main.split(' ')[0]}, ${main.split(' ').slice(1).join(' ')}.`,
        ], () => `${intro}; ${main}.`),
      };
    },
  },
  {
    idPrefix: 'gen-eng-comma2', subject: 'English', topic: 'Comma Usage', difficulty: 'medium',
    build(rng) {
      const [subject, clause, rest] = pick(rng, NONESSENTIAL);
      return {
        prompt: `Which sentence correctly punctuates the nonessential description?`,
        explanation: `Nonessential information needs a comma on BOTH sides: "${subject}, ${clause}, ${rest}." A single comma is always wrong for this structure.`,
        ...buildChoices(rng, `${subject}, ${clause}, ${rest}.`, [
          `${subject} ${clause}, ${rest}.`,
          `${subject}, ${clause} ${rest}.`,
          `${subject} ${clause} ${rest}.`,
        ], () => `${subject}; ${clause}; ${rest}.`),
      };
    },
  },
  {
    idPrefix: 'gen-eng-splice', subject: 'English', topic: 'Comma Usage', difficulty: 'hard',
    build(rng) {
      const [first, second] = pick(rng, INDEPENDENT_PAIRS);
      const transition = pick(rng, ['however', 'therefore', 'nevertheless', 'consequently', 'moreover']);
      return {
        prompt: `Which sentence is punctuated correctly?`,
        explanation: `Two independent clauses joined by "${transition}" need a semicolon before it and a comma after. Using commas alone creates a comma splice.`,
        ...buildChoices(rng, `${first}; ${transition}, ${second}.`, [
          `${first}, ${transition}, ${second}.`,
          `${first} ${transition}; ${second}.`,
          `${first}, ${transition} ${second}.`,
        ], () => `${first} ${transition} ${second}.`),
      };
    },
  },
  {
    idPrefix: 'gen-eng-semi', subject: 'English', topic: 'Semicolons and Colons', difficulty: 'medium',
    build(rng) {
      const [first, second] = pick(rng, INDEPENDENT_PAIRS);
      return {
        prompt: `Which sentence uses the semicolon correctly?`,
        explanation: `A semicolon joins two complete independent clauses with no conjunction. Both "${first}" and "${second}" can stand alone, so "${first}; ${second}." is correct.`,
        ...buildChoices(rng, `${first}; ${second}.`, [
          `${first}; and ${second}.`,
          `Because ${first.toLowerCase()}; ${second}.`,
          `${first}; ${second.split(' ').slice(1).join(' ')}.`,
        ], () => `${first}, ${second}.`),
      };
    },
  },
  {
    idPrefix: 'gen-eng-parallel', subject: 'English', topic: 'Parallel Structure', difficulty: 'medium',
    build(rng) {
      const [a, b, c, broken] = pick(rng, GERUND_TRIPLES);
      return {
        prompt: `Which sentence uses parallel structure correctly?`,
        explanation: `Items in a list must share the same grammatical form. "${a}, ${b}, and ${c}" are all gerunds; switching to "${broken}" breaks the pattern.`,
        ...buildChoices(rng, `She likes ${a}, ${b}, and ${c}.`, [
          `She likes ${a}, ${b}, and ${broken}.`,
          `She likes to ${a.replace(/ing$/, '')}, ${b}, and ${c}.`,
          `She likes ${a}, ${broken}, and ${c}.`,
        ], () => `She likes ${a} and ${broken}.`),
      };
    },
  },
  {
    idPrefix: 'gen-eng-dangle', subject: 'English', topic: 'Modifiers', difficulty: 'medium',
    build(rng) {
      const [modifier, subject, wrong, right] = pick(rng, DANGLERS);
      return {
        prompt: `What is wrong with this sentence?  ${modifier}, ${wrong}.`,
        explanation: `As written, the modifier "${modifier}" attaches to the wrong noun. It must describe ${subject}: "${modifier}, ${right}."`,
        ...buildChoices(rng, `The modifier "${modifier}" describes the wrong noun`, [
          'There is a subject-verb agreement error',
          'The sentence needs a semicolon',
          'The verb tense is incorrect',
        ], () => 'The pronoun is ambiguous'),
      };
    },
  },
  {
    idPrefix: 'gen-eng-apos1', subject: 'English', topic: 'Apostrophes', difficulty: 'easy',
    build(rng) {
      const animal = pick(rng, ['dog', 'cat', 'horse', 'rabbit', 'fox', 'otter', 'parrot', 'lizard']);
      const part = pick(rng, ['tail', 'ears', 'paws', 'nose']);
      return {
        prompt: `Choose the correct word:  The ${animal} twitched ____ ${part}.`,
        explanation: `"Its" is the possessive form. "It's" is a contraction of "it is". Possessive pronouns never take an apostrophe.`,
        ...buildChoices(rng, 'its', ["it's", "its'", "it's'"], () => 'his'),
      };
    },
  },
  {
    idPrefix: 'gen-eng-apos2', subject: 'English', topic: 'Apostrophes', difficulty: 'medium',
    build(rng) {
      const [group, thing] = pick(rng, POSSESSIVE_NOUNS);
      const singular = group.replace(/s$/, '');
      return {
        prompt: `Choose the correct form:  All of the ____ ${thing} were left behind.`,
        explanation: `Multiple ${group} possess the ${thing}, so use the plural possessive: add an apostrophe after the existing s, giving "${group}'".`,
        ...buildChoices(rng, `${group}'`, [`${singular}'s`, group, `${group}'s`], () => `${singular}s'`),
      };
    },
  },
  {
    idPrefix: 'gen-eng-affect', subject: 'English', topic: 'Word Choice', difficulty: 'medium',
    build(rng) {
      const thing = pick(rng, ['new policy', 'schedule change', 'budget cut', 'weather delay', 'rule change', 'merger', 'road closure']);
      const who = pick(rng, ['everyone in the building', 'the entire department', 'all the students', 'every commuter', 'the whole team']);
      return {
        prompt: `Choose the correct word:  The ${thing} will ____ ${who}.`,
        explanation: `"Affect" is the verb meaning to influence. "Effect" is almost always the noun meaning the result. A verb is needed here.`,
        ...buildChoices(rng, 'affect', ['effect', 'affects', 'effects'], () => 'affected'),
      };
    },
  },
  {
    idPrefix: 'gen-eng-fewer', subject: 'English', topic: 'Word Choice', difficulty: 'medium',
    build(rng) {
      const countable = pick(rng, ['students', 'cars', 'books', 'chairs', 'applications', 'errors', 'tickets', 'seats']);
      return {
        prompt: `Choose the correct word:  There were ____ ${countable} than last year.`,
        explanation: `Use "fewer" for things you can count individually (${countable}) and "less" for quantities you cannot count, like water or time.`,
        ...buildChoices(rng, 'fewer', ['less', 'lesser', 'least'], () => 'little'),
      };
    },
  },
  {
    idPrefix: 'gen-eng-there', subject: 'English', topic: 'Word Choice', difficulty: 'easy',
    build(rng) {
      const outcome = pick(rng, ['going to be late', 'bringing the equipment', 'expecting a delay', 'planning to leave early', 'hoping for better weather']);
      return {
        prompt: `Choose the correct word:  ____ ${outcome} if we do not hurry.`,
        explanation: `"They're" is the contraction of "they are". "Their" shows possession and "there" refers to a place.`,
        ...buildChoices(rng, "They're", ['Their', 'There', 'Theyre'], () => "There're"),
      };
    },
  },
  {
    idPrefix: 'gen-eng-tense', subject: 'English', topic: 'Verb Tense', difficulty: 'medium',
    build(rng) {
      const event = pick(rng, ['the movie ended', 'the bell rang', 'the guests arrived', 'the meeting finished', 'the storm cleared']);
      const duration = pick(rng, ['three hours', 'two days', 'forty minutes', 'a week', 'an entire afternoon']);
      return {
        prompt: `Choose the correct verb:  By the time ${event}, we ____ waiting for ${duration}.`,
        explanation: `The past perfect "had been" describes an action completed before another past action (${event}).`,
        ...buildChoices(rng, 'had been', ['have been', 'are', 'will be'], () => 'was'),
      };
    },
  },
  {
    idPrefix: 'gen-eng-concise', subject: 'English', topic: 'Redundancy', difficulty: 'medium',
    build(rng) {
      const pairs = [
        ['annually', 'annually every year', 'each year on an annual basis'],
        ['daily', 'daily every day', 'each day on a daily basis'],
        ['monthly', 'monthly every month', 'each month on a monthly basis'],
        ['weekly', 'weekly every week', 'each week on a weekly schedule'],
      ];
      const [concise, redundant, wordy] = pick(rng, pairs);
      const body = pick(rng, ['The committee meets', 'The club gathers', 'The board convenes', 'The team reports']);
      return {
        prompt: `Which version is most concise without losing meaning?`,
        explanation: `"${concise}" already carries the full meaning, so the longer versions repeat themselves. On standardized tests the shortest option that preserves meaning is usually correct.`,
        ...buildChoices(rng, `${body} ${concise}.`, [
          `${body} ${redundant}.`,
          `${body} ${wordy}.`,
          `${body} ${concise} without fail every single time.`,
        ], () => `${body} on a regular recurring basis.`),
      };
    },
  },
  {
    idPrefix: 'gen-eng-transition', subject: 'English', topic: 'Transitions', difficulty: 'medium',
    build(rng) {
      const cases = [
        ['The study had a large sample size', 'its conclusions were widely questioned', 'Nevertheless', 'contrast'],
        ['The budget was approved in March', 'no funds were released until August', 'However', 'contrast'],
        ['Rainfall was far below average', 'the reservoir levels held steady', 'Surprisingly', 'contrast'],
        ['The prototype failed three safety tests', 'the launch was postponed', 'Consequently', 'cause and effect'],
        ['Sales doubled in the first quarter', 'the company expanded hiring', 'Therefore', 'cause and effect'],
        ['The soil here is thin and rocky', 'few crops grow well', 'As a result', 'cause and effect'],
      ];
      const [first, second, answer, kind] = pick(rng, cases);
      const wrongKind = kind === 'contrast'
        ? ['Therefore', 'Consequently', 'As a result']
        : ['However', 'Nevertheless', 'Conversely'];
      return {
        prompt: `Choose the best transition:  ${first}. ____, ${second}.`,
        explanation: `The two sentences show ${kind}, so "${answer}" is the right signal. The other options point the reader in the wrong logical direction.`,
        ...buildChoices(rng, answer, [...wrongKind, 'For example'], () => 'In addition'),
      };
    },
  },
];

module.exports = templates;
