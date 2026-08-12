import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { bigText, bigTextWidth, logoBar, logoMark, relayLogo, LOGO_TEXT } from '../src/ui/logo.ts';
import { borders, gauge, layoutWidth, panel, panelInnerWidth, statusBar, table } from '../src/ui/box.ts';
import { padVisible, paint, stripAnsi, truncateVisible, visibleWidth, type Theme } from '../src/ui/theme.ts';

const COLOR: Theme = { color: true, unicode: true, interactive: true };
const PLAIN: Theme = { color: false, unicode: true, interactive: false };
const ASCII: Theme = { color: false, unicode: false, interactive: false };

const IS_ASCII = /^[\x00-\x7F]*$/;

describe('measuring painted text', () => {
  it('counts columns, not the bytes colour adds', () => {
    const painted = paint(COLOR, 'green', 'ok');

    assert.notEqual(painted.length, 2, 'this test is pointless if nothing was painted');
    assert.equal(visibleWidth(painted), 2);
    assert.equal(stripAnsi(painted), 'ok');
  });

  it('pads a coloured cell to the width the eye sees', () => {
    // The bug this exists to prevent: padding by `.length` pads a painted cell
    // by the escape bytes too, so every coloured row ends short of the border.
    const padded = padVisible(paint(COLOR, 'red', 'fail'), 10);

    assert.equal(visibleWidth(padded), 10);
    assert.equal(stripAnsi(padded), 'fail      ');
  });

  it('right-aligns, for the columns that carry numbers', () => {
    assert.equal(stripAnsi(padVisible('5.0s', 8, 'right')), '    5.0s');
  });

  it('clips on visible width and never severs an escape sequence', () => {
    const painted = `${paint(COLOR, 'cyan', 'abcdefghij')} tail`;
    const clipped = truncateVisible(painted, 6);

    assert.equal(visibleWidth(clipped), 6);
    assert.equal(stripAnsi(clipped), 'abcde…');
    // A cut that lands mid-sequence would leave the colour open and bleed it
    // down the rest of the screen, so what survives is closed with a reset.
    assert.ok(clipped.endsWith('[0m'), JSON.stringify(clipped));
  });

  it('leaves text that already fits completely alone', () => {
    const painted = paint(COLOR, 'blue', 'short');
    assert.equal(truncateVisible(painted, 40), painted);
  });

  it('survives widths too small to hold even the ellipsis', () => {
    assert.equal(truncateVisible('abcdef', 0), '');
    assert.equal(visibleWidth(truncateVisible('abcdef', 1)), 1);
  });
});

describe('the wordmark', () => {
  it('is a well-formed font: every glyph the same box', () => {
    // A glyph one column short shears every letter after it on that row, and
    // the damage is only visible in the rendered logo — so it is asserted here.
    for (const character of [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -.']) {
      const rendered = bigText(character, PLAIN);
      assert.equal(rendered.length, 5, `${character} is not 5 rows`);
      for (const row of bigText(character, PLAIN).map((line) => line.padEnd(5))) {
        assert.equal(row.length, 5, `${character} has a row of the wrong width: ${JSON.stringify(row)}`);
      }
      assert.ok(rendered.some((row) => row.trim().length > 0) || character === ' ', `${character} is blank`);
    }
  });

  it('draws RELAY in blocks, and the same letters in ASCII when it must', () => {
    const blocks = bigText(LOGO_TEXT, PLAIN);
    const ascii = bigText(LOGO_TEXT, ASCII);

    assert.equal(blocks.length, 5);
    assert.ok(blocks.join('').includes('█'));
    assert.ok(IS_ASCII.test(ascii.join('\n')), 'RELAY_ASCII and TERM=dumb must get a drawable logo');
    assert.ok(ascii.join('').includes('#'));
    // Same drawing, different ink: one table serves both alphabets.
    assert.deepEqual(ascii, blocks.map((row) => row.replaceAll('█', '#')));
  });

  it('reports the width it needs, and never exceeds it', () => {
    const width = bigTextWidth(LOGO_TEXT);
    assert.equal(width, 29);
    for (const row of bigText(LOGO_TEXT, PLAIN)) assert.ok(row.length <= width, row);
  });

  it('renders an unknown character as a blank rather than throwing', () => {
    // Decoration must never be able to fail a command the user actually asked for.
    const rendered = bigText('R★Y', PLAIN);
    assert.equal(rendered.length, 5);
    assert.ok(!rendered.join('').includes('★'));
  });

  it('drops to the compact mark when the terminal cannot hold the full one', () => {
    const full = relayLogo({ theme: PLAIN, width: 80 });
    const narrow = relayLogo({ theme: PLAIN, width: 20 });

    assert.equal(full.length, 5);
    assert.equal(narrow.length, 1);
    assert.ok(narrow[0]?.includes(LOGO_TEXT));
  });

  it('rules a tagline off against the mark above it', () => {
    const lines = relayLogo({ theme: PLAIN, width: 80, tagline: 'a tagline' });

    assert.equal(lines.length, 7);
    assert.equal(lines.at(-1), 'a tagline');
    assert.equal(visibleWidth(lines.at(-2) ?? ''), bigTextWidth(LOGO_TEXT));
  });

  it('fills the title bar to exactly the width it was given', () => {
    for (const width of [40, 76, 92]) {
      assert.equal(visibleWidth(logoBar(PLAIN, 'Issue #142', width)), width, `width ${width}`);
      assert.equal(visibleWidth(logoBar(COLOR, 'Issue #142', width)), width, `painted, width ${width}`);
    }
  });

  it('keeps the mark ASCII when the terminal is', () => {
    assert.ok(IS_ASCII.test(logoMark(ASCII)));
    assert.ok(IS_ASCII.test(logoBar(ASCII, 'Issue #142', 60)));
  });
});

describe('panels', () => {
  const body = ['first', 'second'];

  it('draws every line at exactly the requested width', () => {
    for (const width of [36, 60, 92]) {
      const lines = panel({ theme: PLAIN, width, title: 'Title', badge: '2 ok', body, footer: ['footer'] });
      for (const line of lines) assert.equal(visibleWidth(line), width, `${JSON.stringify(line)} at ${width}`);
    }
  });

  it('holds that width when the content is painted', () => {
    // The regression this guards: colour bytes counted as columns make the
    // right-hand border wander from row to row.
    const lines = panel({
      theme: COLOR,
      width: 50,
      title: 'Title',
      badge: paint(COLOR, 'yellow', '1 warning'),
      body: [paint(COLOR, 'green', 'ok'), paint(COLOR, 'red', 'fail')],
      footer: [paint(COLOR, 'gray', 'footer')],
    });

    for (const line of lines) assert.equal(visibleWidth(line), 50, JSON.stringify(stripAnsi(line)));
  });

  it('keeps the title when the badge beside it is painted', () => {
    // A painted badge measured by `.length` counts its escape bytes against the
    // title's room, which deletes the title outright on a narrow terminal —
    // and only ever with colour on, which is the case nobody tests by hand.
    const lines = panel({
      theme: COLOR,
      width: 38,
      title: 'relay doctor',
      badge: paint(COLOR, 'yellow', '8 ok · 1 warning'),
      body,
    });

    assert.ok(stripAnsi(lines[0] ?? '').includes('relay doctor'), stripAnsi(lines[0] ?? ''));
    assert.equal(visibleWidth(lines[0] ?? ''), 38);
  });

  it('clips content instead of letting a long line push the border out', () => {
    const lines = panel({ theme: PLAIN, width: 40, body: ['x'.repeat(200)] });

    for (const line of lines) assert.equal(visibleWidth(line), 40);
    assert.ok(lines[1]?.includes('…'));
  });

  it('shortens a long title rather than losing the corner', () => {
    const lines = panel({ theme: PLAIN, width: 40, title: 'a title far too long to fit in here', badge: '9 runs' });
    const top = lines[0] ?? '';

    assert.equal(visibleWidth(top), 40);
    assert.ok(top.startsWith('╭─'), top);
    assert.ok(top.endsWith('─╮'), top);
    assert.ok(top.includes('9 runs'), 'the badge is a count and must survive the clip');
  });

  it('divides a footer from the body, and omits the divider when there is none', () => {
    const withFooter = panel({ theme: PLAIN, width: 30, body, footer: ['total'] });
    const without = panel({ theme: PLAIN, width: 30, body });

    assert.equal(withFooter.length, without.length + 2);
    assert.ok(withFooter.some((line) => line.startsWith('├')));
    assert.ok(!without.some((line) => line.startsWith('├')));
  });

  it('is drawable on a terminal with no box-drawing characters', () => {
    const lines = panel({ theme: ASCII, width: 40, title: 'relay doctor', body, footer: ['done'] });

    assert.ok(IS_ASCII.test(lines.join('\n')), lines.join('\n'));
    for (const line of lines) assert.equal(visibleWidth(line), 40);
    assert.equal(borders(ASCII).vertical, '|');
  });

  it('reserves the same room for content as it gives', () => {
    const inner = panelInnerWidth(60);
    const lines = panel({ theme: PLAIN, width: 60, body: ['y'.repeat(inner)] });

    assert.ok(!lines[1]?.includes('…'), 'content exactly as wide as the inner width must not be clipped');
  });
});

describe('tables', () => {
  const data = [
    ['20260812T090300-4f2a1c', 'Complete', '#142 Add rate limiting'],
    ['20260811T164500-9bc233', 'Failed', '#139 Flaky cleanup'],
  ];

  it('aligns every column down the rows', () => {
    const lines = table(PLAIN, [{ header: 'RUN' }, { header: 'PHASE' }, { header: 'ISSUE' }], data);

    assert.equal(lines.length, 3);
    const issueColumn = lines.slice(1).map((line) => line.indexOf('#'));
    assert.equal(issueColumn[0], issueColumn[1], 'the issue column must start in the same place on every row');
  });

  it('omits the header when no column has one to show', () => {
    const lines = table(PLAIN, [{ header: '' }, { header: '' }, { header: '' }], data);
    assert.equal(lines.length, 2);
  });

  it('clips a capped column instead of widening the table', () => {
    const lines = table(PLAIN, [{ header: '' }, { header: '' }, { header: '', max: 10 }], data);

    for (const line of lines) assert.ok(visibleWidth(line) <= 22 + 2 + 8 + 2 + 10, line);
    assert.ok(lines[0]?.includes('…'));
  });

  it('leaves no trailing whitespace on a row', () => {
    for (const line of table(PLAIN, [{ header: '' }, { header: '' }, { header: '' }], data)) {
      assert.equal(line, line.trimEnd(), JSON.stringify(line));
    }
  });

  it('measures painted cells by their visible width', () => {
    const painted = [['a', paint(COLOR, 'green', 'Complete')], ['b', paint(COLOR, 'red', 'Failed')]];
    const lines = table(COLOR, [{ header: '' }, { header: '' }], painted);

    assert.deepEqual(lines.map((line) => stripAnsi(line)), ['a  Complete', 'b  Failed']);
  });
});

describe('gauges and bars', () => {
  it('fills in proportion to the ratio', () => {
    assert.equal(stripAnsi(gauge(PLAIN, 0.5, 10)), '█████░░░░░');
    assert.equal(stripAnsi(gauge(PLAIN, 0, 10)), '░'.repeat(10));
    assert.equal(stripAnsi(gauge(PLAIN, 1, 10)), '█'.repeat(10));
  });

  it('clamps anything outside 0..1, including NaN', () => {
    assert.equal(visibleWidth(gauge(PLAIN, 5, 8)), 8);
    assert.equal(visibleWidth(gauge(PLAIN, -3, 8)), 8);
    assert.equal(stripAnsi(gauge(PLAIN, Number.NaN, 8)), '░'.repeat(8));
  });

  it('has an ASCII form', () => {
    assert.equal(gauge(ASCII, 0.5, 8), '[####----]');
    assert.ok(IS_ASCII.test(gauge(ASCII, 0.5, 8)));
  });

  it('pins a status bar to both margins', () => {
    const bar = statusBar('left', 'right', 40);

    assert.equal(visibleWidth(bar), 40);
    assert.ok(bar.startsWith('left'));
    assert.ok(bar.endsWith('right'));
  });

  it('keeps the two sides apart even when they do not fit', () => {
    const bar = statusBar('a'.repeat(30), 'b'.repeat(30), 20);
    assert.ok(bar.includes('a b'), 'the sides must never run together');
  });
});

describe('layout width', () => {
  it('leaves a column spare so a full-width line cannot wrap', () => {
    assert.equal(layoutWidth({ columns: 80 } as NodeJS.WriteStream), 79);
  });

  it('caps a very wide terminal, because a 200-column measure is unreadable', () => {
    assert.equal(layoutWidth({ columns: 200 } as NodeJS.WriteStream), 92);
  });

  it('has a floor, so a narrow terminal still gets a frame it can draw', () => {
    assert.equal(layoutWidth({ columns: 10 } as NodeJS.WriteStream), 36);
  });

  it('assumes 80 when the stream does not say', () => {
    assert.equal(layoutWidth({} as NodeJS.WriteStream), 79);
  });
});
