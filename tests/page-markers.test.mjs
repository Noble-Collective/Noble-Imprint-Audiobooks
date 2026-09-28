// Print page markers (`<!-- page 27 -->`, see Noble-Imprint-App
// plans/2026-09-28-reader-header-tabs.md) are for the readers' "Go to page";
// narration must not see them. A tagged session must preprocess EXACTLY like
// the untagged one — same spoken text, same blocks, so the same content hash
// (no regeneration, no credits).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { preprocessSession } from '../src/preprocess-tts.js';

const untagged = `# Introduction: The Opening

## Session Overview

### Confessional Statement

>Disciples of Christ:
>earnestly receive God's salvation by repenting from sin and pledging faith in Christ.

## Introduction

Jesus is calling people to follow him on the path to life. Humans seek earnestly for meaning, purpose, and harmony in their lives. The brokenness of the world is mental, and behavioral in nature.

<Question id=Q3>3. **Divine Rescue**: How does this message announce the good news?</Question>
`;

// The same text as the tagger writes it: own-line markers above blocks, one
// mid-sentence, one above a question.
const tagged = `# Introduction: The Opening

## Session Overview

<!-- page 24 -->
### Confessional Statement

>Disciples of Christ:
>earnestly receive God's salvation by repenting from sin and pledging faith in Christ.

<!-- page 26 -->
## Introduction

Jesus is calling people to follow him on the path to life. Humans seek earnestly for meaning, purpose, and harmony in their lives. The brokenness of the world is <!-- page 27 -->mental, and behavioral in nature.

<!-- page xii -->
<Question id=Q3>3. **Divine Rescue**: How does this message announce the good news?</Question>
`;

const hash = (pre) => createHash('sha256').update(pre.plainText).digest('hex');

test('page markers are invisible to narration: same text, blocks and hash', () => {
  const a = preprocessSession(untagged, 'voice', 'en', false);
  const b = preprocessSession(tagged, 'voice', 'en', false);
  assert.equal(b.plainText, a.plainText);
  assert.deepEqual(b, a);
  assert.equal(hash(b), hash(a));
  assert.ok(!b.plainText.includes('page 2'), 'a marker is never spoken');
});

test('other comments are left alone (their handling is unchanged)', () => {
  const withInclude = untagged + '\n<!-- @include: SeriesOverview -->\n';
  const before = preprocessSession(withInclude, 'voice');
  assert.equal(
    preprocessSession(withInclude.replace('## Introduction', '<!-- page 26 -->\n## Introduction'), 'voice').plainText,
    before.plainText,
  );
});
