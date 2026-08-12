'use strict';

const { randInt, pick, fmt, buildChoices, numericFallback } = require('./generator-core');

/**
 * Coding and computer-science templates.
 *
 * Some of these are genuinely computed (Fibonacci values, binary search step
 * counts, loop iteration totals). The rest vary the algorithm or scenario from a
 * bank, which is the right unit of variation: the skill being tested is
 * recognising which complexity class or data structure applies, and that only
 * transfers if the student sees many different cases.
 */

const COMPLEXITY_FACTS = [
  ['binary search on a sorted array', 'O(log n)', 'Each comparison discards half the remaining elements.'],
  ['merge sort', 'O(n log n)', 'The array splits in half log n times, with O(n) merging work per level.'],
  ['heapsort', 'O(n log n)', 'Each of the n extractions costs O(log n) to restore the heap property.'],
  ['bubble sort in the worst case', 'O(n^2)', 'Every element is compared against every other element.'],
  ['selection sort', 'O(n^2)', 'Each of the n passes scans the remaining unsorted portion.'],
  ['insertion sort in the worst case', 'O(n^2)', 'A reverse-sorted input shifts every earlier element on each insertion.'],
  ['a linear scan of an unsorted array', 'O(n)', 'Every element may need to be examined once.'],
  ['an average hash map lookup', 'O(1)', 'The key hashes directly to an index, so no search is needed.'],
  ['pushing onto a stack', 'O(1)', 'The insertion point is always the top; nothing else moves.'],
  ['breadth-first search over a graph', 'O(V + E)', 'Every vertex is enqueued once and every edge examined once.'],
  ['depth-first search over a graph', 'O(V + E)', 'Every vertex and edge is visited once.'],
  ['accessing an array element by index', 'O(1)', 'The address is computed arithmetically from the index.'],
  ['finding an element in a balanced binary search tree', 'O(log n)', 'Each comparison eliminates one subtree.'],
  ['counting sort over a fixed value range', 'O(n)', 'Each element is tallied once, independent of comparisons.'],
];

const ALL_COMPLEXITIES = ['O(1)', 'O(log n)', 'O(n)', 'O(n log n)', 'O(n^2)', 'O(2^n)', 'O(V + E)'];

const STRUCTURE_USES = [
  ['average O(1) lookup by key', 'Hash map', ['Sorted array', 'Linked list', 'Binary search tree']],
  ['checking whether brackets in an expression are balanced', 'Stack', ['Queue', 'Hash map', 'Binary tree']],
  ['exploring a graph level by level', 'Queue', ['Stack', 'Priority queue', 'Hash set']],
  ['always retrieving the smallest remaining element', 'Priority queue', ['Stack', 'Queue', 'Linked list']],
  ['undoing the most recent action first', 'Stack', ['Queue', 'Hash map', 'Array']],
  ['storing unique values with fast membership tests', 'Hash set', ['Array', 'Linked list', 'Stack']],
  ['keeping elements in sorted order with fast insertion', 'Balanced binary search tree', ['Array', 'Stack', 'Hash map']],
  ['processing jobs in the order they arrived', 'Queue', ['Stack', 'Priority queue', 'Hash set']],
  ['looking up a value by its position in constant time', 'Array', ['Linked list', 'Queue', 'Hash set']],
];

const ALL_STRUCTURES = [
  'Hash map', 'Stack', 'Queue', 'Priority queue', 'Array',
  'Linked list', 'Binary search tree', 'Hash set', 'Balanced binary search tree', 'Binary tree',
];

function fib(n) {
  let a = 0; let b = 1;
  for (let i = 0; i < n; i++) [a, b] = [b, a + b];
  return a;
}

const templates = [
  {
    idPrefix: 'gen-code-bigo1', subject: 'Coding', topic: 'Big-O Complexity', difficulty: 'medium',
    build(rng) {
      const [algorithm, answer, why] = pick(rng, COMPLEXITY_FACTS);
      const wrong = ALL_COMPLEXITIES.filter((c) => c !== answer);
      return {
        prompt: `What is the time complexity of ${algorithm}?`,
        explanation: `${answer}. ${why}`,
        ...buildChoices(rng, answer, [pick(rng, wrong), pick(rng, wrong), pick(rng, wrong), ...wrong],
          (i) => ALL_COMPLEXITIES[i % ALL_COMPLEXITIES.length]),
      };
    },
  },
  {
    idPrefix: 'gen-code-bigo2', subject: 'Coding', topic: 'Big-O Complexity', difficulty: 'medium',
    build(rng) {
      const depth = randInt(rng, 2, 4);
      const answer = depth === 2 ? 'O(n^2)' : depth === 3 ? 'O(n^3)' : 'O(n^4)';
      const nested = depth === 2 ? 'Two' : depth === 3 ? 'Three' : 'Four';
      return {
        prompt: `${nested} nested loops each run from 0 to n-1, with O(1) work in the innermost body. What is the time complexity?`,
        explanation: `Each loop multiplies the work of the one inside it, giving n^${depth}, so the complexity is ${answer}.`,
        ...buildChoices(rng, answer, ['O(n)', `O(${depth}n)`, 'O(n log n)', 'O(n^2)', 'O(n^3)', 'O(n^4)'].filter((c) => c !== answer),
          (i) => `O(n^${depth + i + 2})`),
      };
    },
  },
  {
    idPrefix: 'gen-code-bigo3', subject: 'Coding', topic: 'Big-O Complexity', difficulty: 'hard',
    build(rng) {
      const cases = [
        ['insert n items into a hash set, then perform n lookups', 'O(n)', 'Each operation averages O(1), so 2n constant-time operations simplify to O(n).'],
        ['sort an array of n items, then binary search it n times', 'O(n log n)', 'Sorting costs O(n log n) and n binary searches cost O(n log n), so the total stays O(n log n).'],
        ['for each of n items, scan the whole array of n items', 'O(n^2)', 'The inner scan runs n times for each of the n outer iterations.'],
        ['halve a value repeatedly until it reaches 1, doing O(1) work each step', 'O(log n)', 'Repeated halving takes log base 2 of n steps.'],
        ['visit every cell of an n by n grid once', 'O(n^2)', 'There are n^2 cells and each is visited once.'],
      ];
      const [scenario, answer, why] = pick(rng, cases);
      return {
        prompt: `An algorithm does the following: ${scenario}. What is its overall time complexity?`,
        explanation: `${answer}. ${why}`,
        ...buildChoices(rng, answer, ALL_COMPLEXITIES.filter((c) => c !== answer),
          (i) => `O(n^${i + 3})`),
      };
    },
  },
  {
    idPrefix: 'gen-code-bigo4', subject: 'Coding', topic: 'Big-O Complexity', difficulty: 'hard',
    build(rng) {
      const cases = [
        ['a single hash map lookup', 'O(n)', 'O(1)', 'If every key collides into one bucket, the lookup degrades to scanning n entries.'],
        ['quicksort', 'O(n^2)', 'O(n log n)', 'Consistently bad pivots make the partitions maximally unbalanced.'],
        ['searching an unbalanced binary search tree', 'O(n)', 'O(log n)', 'A degenerate tree is effectively a linked list.'],
        ['inserting into a dynamic array', 'O(n)', 'O(1)', 'When capacity runs out the whole array is copied to a larger block.'],
      ];
      const [thing, worst, average, why] = pick(rng, cases);
      return {
        prompt: `What is the WORST-CASE time complexity of ${thing}?`,
        explanation: `${worst}. ${why} The average case is ${average}, which is what people usually quote.`,
        ...buildChoices(rng, worst, [average, ...ALL_COMPLEXITIES.filter((c) => c !== worst && c !== average)],
          (i) => `O(n^${i + 3})`),
      };
    },
  },
  {
    idPrefix: 'gen-code-struct', subject: 'Coding', topic: 'Data Structures', difficulty: 'medium',
    build(rng) {
      const [use, answer, distractors] = pick(rng, STRUCTURE_USES);
      return {
        prompt: `Which data structure is the natural choice for ${use}?`,
        explanation: `${answer} fits because its access pattern matches the requirement directly. The alternatives would need extra work or extra passes.`,
        ...buildChoices(rng, answer, distractors,
          (i) => ALL_STRUCTURES.filter((s) => s !== answer)[i % (ALL_STRUCTURES.length - 1)]),
      };
    },
  },
  {
    idPrefix: 'gen-code-bsearch', subject: 'Coding', topic: 'Binary Search', difficulty: 'medium',
    build(rng) {
      const n = pick(rng, [16, 32, 64, 100, 128, 256, 500, 1000, 1024, 2048, 4096, 10000]);
      const steps = Math.ceil(Math.log2(n));
      return {
        prompt: `Approximately how many comparisons does binary search need in the worst case on ${n} sorted elements?`,
        explanation: `log base 2 of ${n} is about ${fmt(Math.round(Math.log2(n) * 100) / 100)}, so roughly ${steps} comparisons. Doubling the input adds only one more step.`,
        ...buildChoices(rng, fmt(steps), [
          fmt(n),                    // assumed a linear scan
          fmt(Math.round(n / 2)),    // assumed halving once
          fmt(steps * 2),
        ], numericFallback(steps)),
      };
    },
  },
  {
    idPrefix: 'gen-code-fib', subject: 'Coding', topic: 'Recursion', difficulty: 'medium',
    build(rng) {
      const n = randInt(rng, 5, 14);
      const value = fib(n);
      return {
        prompt: `Given fib(0) = 0 and fib(1) = 1, what is fib(${n})?`,
        explanation: `The sequence runs 0, 1, 1, 2, 3, 5, 8, 13, ... Counting from index 0, fib(${n}) = ${value}.`,
        ...buildChoices(rng, fmt(value), [
          fmt(fib(n + 1)),    // off by one in the index
          fmt(fib(n - 1)),
          fmt(value * 2),
        ], numericFallback(value)),
      };
    },
  },
  {
    idPrefix: 'gen-code-loopcount', subject: 'Coding', topic: 'Loops and Iteration', difficulty: 'easy',
    build(rng) {
      const start = randInt(rng, 0, 5);
      const end = randInt(rng, 10, 40);
      const count = end - start;
      return {
        prompt: `How many times does the body of this loop run?  for (let i = ${start}; i < ${end}; i++)`,
        explanation: `The loop runs while i is less than ${end}, starting at ${start}, so it executes ${end} - ${start} = ${count} times. Because the bound is exclusive, ${end} itself is never used.`,
        ...buildChoices(rng, fmt(count), [
          fmt(count + 1),    // treated the bound as inclusive
          fmt(end),
          fmt(count - 1),
        ], numericFallback(count)),
      };
    },
  },
  {
    idPrefix: 'gen-code-sumn', subject: 'Coding', topic: 'Loops and Iteration', difficulty: 'medium',
    build(rng) {
      const n = pick(rng, [10, 20, 50, 100, 200, 1000]);
      const total = (n * (n + 1)) / 2;
      return {
        prompt: `What is the sum of the integers from 1 to ${n}?`,
        explanation: `Use n(n+1)/2 = ${n} x ${n + 1} / 2 = ${total}. A loop gives the same answer in O(n) time; the formula is O(1).`,
        ...buildChoices(rng, fmt(total), [
          fmt((n * n) / 2),          // dropped the +1
          fmt(n * (n + 1)),          // forgot to halve
          fmt(n * n),
        ], numericFallback(total)),
      };
    },
  },
  {
    idPrefix: 'gen-code-swaps', subject: 'Coding', topic: 'Two Pointers', difficulty: 'hard',
    build(rng) {
      const n = randInt(rng, 5, 21);
      const swaps = Math.floor(n / 2);
      return {
        prompt: `Reversing an array of ${n} elements in place with two pointers requires how many swaps?`,
        explanation: `The pointers move toward each other and meet in the middle, so the count is floor(${n}/2) = ${swaps}.${n % 2 === 1 ? ' The middle element stays where it is.' : ''}`,
        ...buildChoices(rng, fmt(swaps), [
          fmt(n),                // one swap per element
          fmt(n - 1),
          fmt(swaps + 1),
        ], numericFallback(swaps)),
      };
    },
  },
  {
    idPrefix: 'gen-code-approach', subject: 'Coding', topic: 'Arrays and Hashing', difficulty: 'medium',
    build(rng) {
      const cases = [
        ['find two numbers in an UNSORTED array that add to a target',
          'One pass with a hash map of seen values, O(n)',
          ['Nested loops checking every pair, O(n^2)', 'Sort then binary search each element, O(n log n)', 'Recursion over all subsets, O(2^n)'],
          'As you scan, check whether target minus the current value has already been seen.'],
        ['find two numbers in a SORTED array that add to a target',
          'Two pointers from each end, O(n) time and O(1) space',
          ['Nested loops checking every pair, O(n^2)', 'Build a hash map first, O(n) extra space', 'Recursion over all subsets, O(2^n)'],
          'Sortedness lets you move the correct pointer based on whether the sum is too big or too small.'],
        ['detect whether an array contains any duplicate value',
          'Add elements to a hash set and stop when one is already present',
          ['Compare every element to every other element', 'Sort the array and then reverse it', 'Recursively split the array in half'],
          'The hash set approach is O(n) time with O(n) extra space.'],
        ['check whether a string is a palindrome',
          'Two pointers moving inward from both ends',
          ['Reverse the string and compare, using extra space', 'Check every possible substring', 'Sort the characters and compare'],
          'Two pointers run in O(n) time using O(1) extra space.'],
        ['find the most frequent element in an array',
          'Count occurrences in a hash map, then take the maximum',
          ['Sort the array and scan for the longest run of equal values', 'Compare every element to every other element', 'Use binary search on the values'],
          'Counting is a single O(n) pass; sorting would add an unnecessary O(n log n).'],
      ];
      const [problem, answer, distractors, why] = pick(rng, cases);
      return {
        prompt: `What is the most efficient standard approach to ${problem}?`,
        explanation: `${answer}. ${why}`,
        ...buildChoices(rng, answer, distractors, (i) => `Brute force with ${i + 3} nested loops`),
      };
    },
  },
  {
    idPrefix: 'gen-code-space', subject: 'Coding', topic: 'Recursion', difficulty: 'hard',
    build(rng) {
      const cases = [
        ['naive recursive Fibonacci', 'O(n)', 'O(2^n)', 'The call stack only ever holds one root-to-leaf path at a time, and that depth is n.'],
        ['recursively summing a linked list of n nodes', 'O(n)', 'O(n)', 'One stack frame per node until the base case is reached.'],
        ['recursive binary search', 'O(log n)', 'O(log n)', 'The recursion depth matches the number of halvings.'],
        ['depth-first search on a graph with V vertices', 'O(V)', 'O(V + E)', 'In the worst case the stack holds every vertex along one path.'],
      ];
      const [thing, space, time, why] = pick(rng, cases);
      return {
        prompt: `What is the SPACE complexity of ${thing}, counting the call stack?`,
        explanation: `${space}. ${why} Its time complexity is ${time}, which is a separate question.`,
        ...buildChoices(rng, space, [time, ...ALL_COMPLEXITIES.filter((c) => c !== space && c !== time)],
          (i) => `O(n^${i + 2})`),
      };
    },
  },
  {
    idPrefix: 'gen-code-order', subject: 'Coding', topic: 'Stacks and Queues', difficulty: 'easy',
    build(rng) {
      const cases = [
        ['A stack', 'Last in, first out', 'the most recently pushed item is the first one popped'],
        ['A queue', 'First in, first out', 'items leave in the order they arrived'],
      ];
      const [thing, answer, why] = pick(rng, cases);
      return {
        prompt: `${thing} follows which access order?`,
        explanation: `${answer}: ${why}.`,
        ...buildChoices(rng, answer, [
          answer === 'Last in, first out' ? 'First in, first out' : 'Last in, first out',
          'Random access',
          'Sorted order',
        ], () => 'Priority order'),
      };
    },
  },
  {
    idPrefix: 'gen-code-stable', subject: 'Coding', topic: 'Sorting', difficulty: 'hard',
    build(rng) {
      const cases = [
        ['stable', 'Merge sort', ['Quicksort', 'Heapsort', 'Selection sort'],
          'preserves the relative order of equal elements'],
        ['NOT stable', 'Quicksort', ['Merge sort', 'Insertion sort', 'Bubble sort'],
          'can reorder equal elements during partitioning'],
      ];
      const [property, answer, distractors, why] = pick(rng, cases);
      return {
        prompt: `Which of these sorting algorithms is ${property}?`,
        explanation: `${answer} is ${property} because it ${why}. Stability matters when sorting by one key after already sorting by another.`,
        ...buildChoices(rng, answer, distractors, (i) => ['Counting sort', 'Radix sort', 'Shell sort'][i % 3]),
      };
    },
  },
  {
    idPrefix: 'gen-code-strings', subject: 'Coding', topic: 'Strings', difficulty: 'hard',
    build(rng) {
      const n = pick(rng, ['n', '1000', '10000']);
      return {
        prompt: `In a language with immutable strings, what is the complexity of building a string by concatenating inside a loop that runs ${n} times?`,
        explanation: `O(n^2). Each concatenation copies the entire string built so far, so the total work is 1 + 2 + ... + n. Collect the pieces in a list and join once at the end to get O(n).`,
        ...buildChoices(rng, 'O(n^2)', ['O(n)', 'O(log n)', 'O(1)', 'O(n log n)'],
          (i) => `O(n^${i + 3})`),
      };
    },
  },
  {
    idPrefix: 'gen-code-basecase', subject: 'Coding', topic: 'Recursion', difficulty: 'easy',
    build(rng) {
      const missing = pick(rng, ['a base case', 'a terminating condition']);
      return {
        prompt: `What happens if a recursive function is written without ${missing}?`,
        explanation: `It calls itself indefinitely until the call stack runs out of space, producing a stack overflow error.`,
        ...buildChoices(rng, 'It recurses until the call stack overflows', [
          'It returns zero immediately',
          'It silently converts to a loop',
          'It runs faster but uses more memory',
        ], () => 'It throws a syntax error at compile time'),
      };
    },
  },
];

module.exports = templates;
