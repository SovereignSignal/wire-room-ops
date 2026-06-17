require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const { mdToBlocks } = require('../src/services/weekly-notion');

test('mdToBlocks renders "# **AI**" as a bold heading_1 block (not skipped)', () => {
  const blocks = mdToBlocks('# **AI**');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'heading_1');
  const rt = blocks[0].heading_1.rich_text;
  assert.equal(rt[0].text.content, 'AI');
  assert.equal(rt[0].annotations && rt[0].annotations.bold, true);
});

test('mdToBlocks renders [**Name**](url) as a bold link segment', () => {
  const blocks = mdToBlocks('[**Claude Corps**](https://a.co) is an initial **$150M** fund.');
  assert.equal(blocks[0].type, 'paragraph');
  const seg = blocks[0].paragraph.rich_text[0];
  assert.equal(seg.text.content, 'Claude Corps');
  assert.equal(seg.text.link.url, 'https://a.co');
  assert.equal(seg.annotations && seg.annotations.bold, true);
});

test('mdToBlocks renders an also-open [Name](url) link WITHOUT bold', () => {
  const blocks = mdToBlocks('- [Band of Agents](https://b.co): $10K. June 19.');
  assert.equal(blocks[0].type, 'bulleted_list_item');
  const seg = blocks[0].bulleted_list_item.rich_text[0];
  assert.equal(seg.text.content, 'Band of Agents');
  assert.equal(seg.text.link.url, 'https://b.co');
  assert.ok(!seg.annotations || !seg.annotations.bold);
});
