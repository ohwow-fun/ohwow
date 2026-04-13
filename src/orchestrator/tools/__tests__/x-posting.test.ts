import { describe, it, expect } from 'vitest';
import { stripMarkdownForXArticle } from '../x-posting.js';

describe('stripMarkdownForXArticle', () => {
  const cases: Array<{ name: string; input: string; expected: string }> = [
    {
      name: 'removes a horizontal rule on its own line',
      input: 'one\n\n---\n\ntwo',
      expected: 'one\n\ntwo',
    },
    {
      name: 'removes a horizontal rule with leading whitespace',
      input: 'one\n\n   ---   \n\ntwo',
      expected: 'one\n\ntwo',
    },
    {
      name: 'strips bold wrappers',
      input: 'This is **very important** to note.',
      expected: 'This is very important to note.',
    },
    {
      name: 'strips bold used as a faux heading',
      input: '**What OHWOW Actually Is**\n\nOHWOW is ...',
      expected: 'What OHWOW Actually Is\n\nOHWOW is ...',
    },
    {
      name: 'strips underline-style bold',
      input: '__bold text__ stays.',
      expected: 'bold text stays.',
    },
    {
      name: 'strips ATX headings of all depths',
      input: '# H1\n## H2\n### H3\n#### H4',
      expected: 'H1\nH2\nH3\nH4',
    },
    {
      name: 'unwraps fenced code blocks with a language tag',
      input: 'Run this:\n\n```bash\nnpx ohwow\n```\n\nDone.',
      expected: 'Run this:\n\nnpx ohwow\n\nDone.',
    },
    {
      name: 'unwraps fenced code blocks with no language tag',
      input: '```\nnpx ohwow\n```',
      expected: 'npx ohwow',
    },
    {
      name: 'unwraps inline code',
      input: 'run `npx ohwow` and go.',
      expected: 'run npx ohwow and go.',
    },
    {
      name: 'unwraps links to text (url) form',
      input: 'See [Product Hunt](https://producthunt.com/ohwow) today.',
      expected: 'See Product Hunt (https://producthunt.com/ohwow) today.',
    },
    {
      name: 'unwraps bare bracket placeholders',
      input: '[Product Hunt link]',
      expected: 'Product Hunt link',
    },
    {
      name: 'collapses 3+ consecutive newlines to 2',
      input: 'a\n\n\n\n\nb',
      expected: 'a\n\nb',
    },
    {
      name: 'trims trailing whitespace per line',
      input: 'line one   \nline two\t\nline three',
      expected: 'line one\nline two\nline three',
    },
    {
      name: 'leaves a plain paragraph untouched',
      input: 'Nothing special about this line.',
      expected: 'Nothing special about this line.',
    },
    {
      name: 'handles the article-2 opening fixture end-to-end',
      input:
        '# Title line\n\nIntro paragraph.\n\n---\n\n**What OHWOW Actually Is**\n\nBody sentence with **inline bold** and a `code token`.\n\n---\n\nOne command: `npx ohwow`.',
      expected:
        'Title line\n\nIntro paragraph.\n\nWhat OHWOW Actually Is\n\nBody sentence with inline bold and a code token.\n\nOne command: npx ohwow.',
    },
  ];

  for (const tc of cases) {
    it(tc.name, () => {
      expect(stripMarkdownForXArticle(tc.input).plainText).toBe(tc.expected);
    });
  }

  it('does not mangle a long realistic launch article', () => {
    const input = [
      '# I Am Open Sourcing the AI System That Runs My Entire Business',
      '',
      'Last week my AI system contacted 47 leads.',
      '',
      '---',
      '',
      '**What OHWOW Actually Is**',
      '',
      'OHWOW is an open-source system.',
      '',
      '- **48 pre-built agents** across 6 business types',
      '- **33 ready-made playbooks** covering ops',
      '',
      '```',
      'npx ohwow',
      '```',
      '',
      '[Product Hunt link]',
    ].join('\n');

    const { plainText } = stripMarkdownForXArticle(input);

    expect(plainText).not.toContain('**');
    expect(plainText).not.toContain('```');
    expect(plainText).not.toMatch(/^---$/m);
    expect(plainText).not.toMatch(/^#\s/m);
    expect(plainText).toContain('I Am Open Sourcing the AI System That Runs My Entire Business');
    expect(plainText).toContain('48 pre-built agents across 6 business types');
    expect(plainText).toContain('npx ohwow');
    expect(plainText).toContain('Product Hunt link');
    expect(plainText).not.toMatch(/\n{3,}/);
  });
});
