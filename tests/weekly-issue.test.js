require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assembleIssue,
  dedupeItems,
  splitByScore,
  stripPriorIssueItems,
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
  assert.ok(md.trimEnd().endsWith('Peace,\nSov'));
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
