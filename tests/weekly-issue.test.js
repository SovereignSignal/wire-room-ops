require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assembleIssue,
  dedupeItems,
  splitByScore,
  stripPriorIssueItems,
  parseVerify,
  isPublishableVerification,
  assertWeeklyCheckpointAllowed,
} = require('../src/jobs/weekly-issue');

function sampleBlocks() {
  return [
    {
      label: 'AI',
      featured: [
        { name: 'Claude Corps', url: 'https://a.co', description: 'is an initial **$150M** fellowship. Deadline **July 17**.' },
      ],
      alsoOpen: [
        { name: 'Band of Agents', url: 'https://b.co', description: '$10K+ for multi-agent builders. June 19.' },
      ],
    },
    {
      label: 'Crypto',
      featured: [
        { name: 'Stellar Grants', url: 'https://s.co', description: 'offers up to **$500K**. Rolling.' },
      ],
      alsoOpen: [],
    },
    {
      label: 'OSS',
      featured: [
        { name: 'Rust Fund', url: 'https://r.co', description: 'funds Rust maintainers.' },
      ],
      alsoOpen: [],
    },
  ];
}

test('assembleIssue renders H1 bold section headers in order AI, Crypto, OSS, Conclusion', () => {
  const md = assembleIssue({ weekEnding: 'June 12, 2026', blocks: sampleBlocks() });
  for (const h of ['# **AI**', '# **Crypto**', '# **OSS**', '# **Conclusion**']) {
    assert.ok(md.includes(h), `missing header ${h}`);
  }
  assert.ok(md.indexOf('# **AI**') < md.indexOf('# **Crypto**'));
  assert.ok(md.indexOf('# **Crypto**') < md.indexOf('# **OSS**'));
  assert.ok(md.indexOf('# **OSS**') < md.indexOf('# **Conclusion**'));
});

test('assembleIssue states the week-ending date in bold', () => {
  const md = assembleIssue({ weekEnding: 'June 12, 2026', blocks: sampleBlocks() });
  assert.ok(md.includes('This issue covers the week ending **June 12, 2026**'));
  assert.ok(md.includes("Alright, let's hop in."));
});

test('featured names are bold + linked; also-open names are linked but NOT bold', () => {
  const md = assembleIssue({ weekEnding: 'June 12, 2026', blocks: sampleBlocks() });
  assert.ok(md.includes('[**Claude Corps**](https://a.co) is an initial **$150M** fellowship.'));
  assert.ok(md.includes('- [Band of Agents](https://b.co): $10K+ for multi-agent builders. June 19.'));
  assert.ok(!md.includes('[**Band of Agents**]'), 'also-open name must not be bold');
});

test('assembleIssue omits the "Also open:" label for a wire with no also-open items', () => {
  const md = assembleIssue({ weekEnding: 'June 12, 2026', blocks: sampleBlocks() });
  const matches = md.match(/Also open:/g) || [];
  assert.equal(matches.length, 1); // only AI has also-open items
});

test('assembleIssue repeats the Telegram channel block at top and in the conclusion', () => {
  const md = assembleIssue({ weekEnding: 'June 12, 2026', blocks: sampleBlocks() });
  const hits = (md.match(/@cryptograntwire/g) || []).length;
  assert.ok(hits >= 2, `expected channel block twice, saw ${hits}`);
  assert.ok(md.includes("That's it for this week!"));
  // The sign-off is no longer the last thing in the issue: the masthead byline
  // follows it. Still assert the sign-off survives and the byline closes out.
  assert.ok(md.includes('Peace,\nSov'), 'the sign-off must survive');
  assert.ok(md.trimEnd().endsWith('just reply.'), 'the byline closes the issue');
});

test('assembleIssue uses no em or en dashes', () => {
  const md = assembleIssue({ weekEnding: 'June 12, 2026', blocks: sampleBlocks() });
  assert.ok(!md.includes('—'), 'no em dash');
  assert.ok(!md.includes('–'), 'no en dash');
});

test('dedupeItems drops same-URL and same-name repeats, keeping the higher score', () => {
  const items = [
    { name: 'NLnet NGI Zero', url: 'https://nlnet.nl/a', quality: 80 },
    { name: 'NLnet NGI Zero', url: 'https://nlnet.nl/b', quality: 70 }, // same name -> drop
    { name: 'Stellar', url: 'https://stellar.org/', quality: 60 },
    { name: 'Stellar Marketing', url: 'https://stellar.org', quality: 50 }, // same normalized url -> drop
  ];
  const out = dedupeItems(items);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map(i => i.quality).sort(), [60, 80]);
});

test('splitByScore sorts by score and takes the top N as featured', () => {
  const items = [
    { name: 'c', quality: 70 },
    { name: 'a', quality: 90 },
    { name: 'b', quality: 80 },
  ];
  const { featured, alsoOpen } = splitByScore(items, 2);
  assert.deepEqual(featured.map(i => i.name), ['a', 'b']);
  assert.deepEqual(alsoOpen.map(i => i.name), ['c']);
});

test('stripPriorIssueItems removes items already in last week\'s issue', () => {
  const prior = 'Last week: [Pulitzer Center](https://pulitzer.org/ai) ran.';
  const items = [
    { name: 'Pulitzer Center', url: 'https://pulitzer.org/ai', quality: 70 },
    { name: 'New Grant', url: 'https://new.org', quality: 60 },
  ];
  const out = stripPriorIssueItems(items, prior);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'New Grant');
});

test('verification parsers require an explicit open verdict', () => {
  const parsed = parseVerify('[{"n":1,"amount":"$10k","deadline":null}]');
  assert.equal(parsed.get(1).open, false);
  assert.equal(parseVerify('not-json').size, 0);
});

test('Parallel verification requires open, cited, usable, medium-or-better evidence', () => {
  const good = {
    is_open: true,
    amount: '$10k',
    deadline: 'rolling',
    apply_url: 'https://official.example/apply',
    citationUrl: 'https://official.example/details',
    confidence: 'medium',
  };
  assert.equal(isPublishableVerification(good, 'https://fallback.example'), true);
  assert.equal(isPublishableVerification({ ...good, is_open: false }, 'https://fallback.example'), false);
  assert.equal(isPublishableVerification({ ...good, citationUrl: null }, 'https://fallback.example'), false);
  assert.equal(isPublishableVerification({ ...good, confidence: 'low' }, 'https://fallback.example'), false);
  assert.equal(isPublishableVerification({ ...good, apply_url: 'http://official.example/apply' }, 'http://fallback.example'), false);
});

test('weekly checkpoint requires delivery unless storage is explicitly skipped', () => {
  assert.doesNotThrow(() => assertWeeklyCheckpointAllowed({ skipEmail: false, skipStore: false, emailed: true, notionLanded: false }));
  assert.doesNotThrow(() => assertWeeklyCheckpointAllowed({ skipEmail: false, skipStore: false, emailed: false, notionLanded: true }));
  assert.doesNotThrow(() => assertWeeklyCheckpointAllowed({ skipEmail: true, skipStore: true, emailed: false, notionLanded: false }));
  assert.throws(
    () => assertWeeklyCheckpointAllowed({ skipEmail: false, skipStore: false, emailed: false, notionLanded: false }),
    /delivery failed/,
  );
  assert.throws(
    () => assertWeeklyCheckpointAllowed({ skipEmail: true, skipStore: false, emailed: false, notionLanded: false }),
    /delivery is skipped/,
  );
});

// The byline is the newsletter's only conversion path. 41 issues held a
// 26-33% open rate and took zero comments because nothing was actionable.
test('assembleIssue closes with the funder-side byline and a reply invitation', () => {
  const md = assembleIssue({
    weekEnding: 'July 24, 2026',
    blocks: [{ label: 'AI', featured: [{ name: 'X', url: 'https://x.test', description: 'does a thing.' }], alsoOpen: [] }],
  });

  assert.match(md, /I'm Sov\. I've run grant programs on the funder side/);
  assert.match(md, /tens of millions across more than a dozen rounds/);
  assert.match(md, /just reply\.$/, 'the reply invitation must be the last thing in the issue');

  // All three ecosystems named: a crypto-only byline tells two thirds of the
  // readers this is not for them.
  assert.match(md, /crypto, AI and OSS/);

  // Masthead position: after the sign-off, so it reads as author metadata
  // rather than a pitch inside the letter.
  assert.ok(md.indexOf("Peace,\nSov") < md.indexOf("I'm Sov."),
    'the byline belongs after the sign-off');

  // No commercial ask. The point is that it costs the reader nothing.
  assert.doesNotMatch(md, /\bhire me\b|\brates?\b|book a call|calendly/i);
});
