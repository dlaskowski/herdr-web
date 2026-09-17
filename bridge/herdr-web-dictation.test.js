// Regression tests for herdr-web's dictation input handling.
//
//   node bridge/herdr-web-dictation.test.js
//
// Worth its existence: this one handler has been got wrong three times, each
// time on a plausible-sounding theory of what iOS dictation emits, and each time
// only discoverable by picking up an iPad. The failing sequence is cheap to
// replay here and expensive to replay on a device.
//
// The logic is LIFTED from bridge/herdr-web.html.in at run time rather than
// copied, so this file cannot drift into testing a stale duplicate of it. That
// is also its limitation: it tests the coalescing rule against sequences we
// believe iOS produces, not iOS itself. If dictation misbehaves again, capture
// the real trace first (open the page with ?debug and read the event log), then
// add the sequence here.
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'herdr-web.html.in'), 'utf8');
const block = src.slice(src.indexOf('  // --- input ---'), src.indexOf('  term.onResize(sendResize);'));
if (!/term\.onData/.test(block)) throw new Error('failed to lift onData block');

// The lifted block is only a slice of the page. Parse the whole script too, so a
// syntax error anywhere else in it cannot slip past a green run here.
let ok = true;
{
  const body = src.slice(src.lastIndexOf('<script>') + '<script>'.length, src.lastIndexOf('</script>'));
  try {
    new Function(body);
    console.log('PASS  page script parses');
  } catch (e) {
    console.log('FAIL  page script does not parse: ' + e.message);
    ok = false;
  }
}

let out, log, now;
function send(s) { out += s; }
function dbg() { log.push([].join.call(arguments, ' ')); }
globalThis.ctrlArmed = false;   // global, so the lifted block sees flips made by tests
function setCtrl(v) { globalThis.ctrlArmed = v; }
function toCtrl(ch) {
  const c = ch.toUpperCase().charCodeAt(0);
  if (c >= 64 && c <= 95) return String.fromCharCode(c & 0x1f);
  return null;
}
const Date_now = Date.now;
Date.now = () => now;

// The coalescer buffers on a timer, so the clock has to be driven rather than
// mocked away: chunks arriving inside the burst window must actually merge, and
// chunks outside it must actually not.
let timers = [], timerSeq = 1;
function fakeSetTimeout(fn, ms) {
  const id = timerSeq++;
  timers.push({ id, at: now + ms, fn });
  return id;
}
function fakeClearTimeout(id) {
  timers = timers.filter(t => t.id !== id);
}
function fireTimersDue(upto) {
  for (;;) {
    const due = timers.filter(t => t.at <= upto).sort((a, b) => a.at - b.at)[0];
    if (!due) return;
    timers = timers.filter(t => t !== due);
    const held = now;
    now = due.at;
    due.fn();
    now = held;
  }
}

// Re-evaluated per test rather than once: the block owns the phrase-in-flight
// state, and a handler carried between cases lets one test's open phrase
// suppress the next test's first chunk.
function freshHandler() {
  let handler;
  timers = [];
  const term = { onData(fn) { handler = fn; } };
  new Function('term', 'send', 'dbg', 'setCtrl', 'toCtrl', 'setTimeout', 'clearTimeout', block)(
    term, send, dbg, setCtrl, toCtrl, fakeSetTimeout, fakeClearTimeout);
  return handler;
}

// What the pane ends up showing, once the DEL bytes a correction sends have
// been applied. Assertions are written against this rather than the raw stream,
// because the raw stream is full of backspaces and unreadable, and what actually
// matters is the text the person sees.
function render(stream) {
  let buf = '';
  for (const ch of stream) {
    if (ch === '\x7f') buf = buf.slice(0, -1);
    else buf += ch;
  }
  return buf;
}

// Each step is [data, msSinceStart].
function run(name, steps, expected) {
  out = ''; log = [];
  const handler = freshHandler();
  for (const [data, t] of steps) {
    now = 1000000 + t;
    fireTimersDue(now);
    handler(data);
  }
  now += 10000;          // let a buffered burst settle before reading the result
  fireTimersDue(now);
  const shown = render(out);
  const pass = shown === expected;
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name);
  if (!pass) {
    console.log('        got  ' + JSON.stringify(shown));
    console.log('        want ' + JSON.stringify(expected));
    console.log('        raw  ' + JSON.stringify(out));
  }
  return pass;
}

// The reported bug, verbatim: "hello world" -> "helhellohello worldhello world"
ok &= run('iOS dictation snapshots',
  [['hel', 0], ['hello', 400], ['hello world', 800], ['hello world', 1400]], 'hello world');

// The mic-off echo: iOS repeats the finished phrase when dictation is switched
// off, at whatever pace the person reaches for the button. Untimed by design.
ok &= run('trailing repeat when the mic is toggled off, seconds later',
  [['hel', 0], ['hello world', 400], ['hello world', 3000]], 'hello world');

ok &= run('mic-off echo after the recognizer already echoed once',
  [['hello world', 0], ['hello world', 500], ['hello world', 4000]], 'hello world');

ok &= run('single keystrokes are never coalesced',
  [['l', 0], ['l', 50], ['o', 90]], 'llo');

ok &= run('typed chars are untouched after dictation',
  [['hello world', 0], ['!', 400], ['!', 600]], 'hello world!!');

// A re-recognised word, which is the same utterance and must be corrected, not
// appended. This expectation is the reverse of what it was before word-level
// revisions were understood.
ok &= run('a re-recognised word is corrected in place',
  [['their', 0], ['there', 400]], 'there');

ok &= run('Enter closes the phrase, so a repeated opening word survives',
  [['hello', 0], ['\r', 400], ['hello', 800], ['hello there', 1200]], 'hello\rhello there');

ok &= run('two separate dictations, second is not an extension',
  [['hel', 0], ['hello', 400], ['goodbye', 2000]], 'hellogoodbye');

// Pasting the same command twice: the Enter in between closes the phrase, which
// is what makes the untimed repeat rule safe in normal terminal use.
ok &= run('same text pasted twice with Enter between',
  [['npm test', 0], ['\r', 500], ['npm test', 2000]], 'npm test\rnpm test');

// The documented trade-off, asserted so it stays a decision and not a surprise:
// with no keystroke at all in between, a second identical phrase is
// indistinguishable from a mic-off echo and is dropped.
ok &= run('same text twice with no keystroke between is deduped (known trade-off)',
  [['npm test', 0], ['npm test', 2000]], 'npm test');

ok &= run('ctrl+c still works',
  (() => { globalThis.ctrlArmed = true; return [['c', 0]]; })(), '\x03');

// The long-dictation trace, verbatim from an iPad. Every snapshot after the
// third revises text iOS had already committed — a comma after "start" appears,
// vanishes, and comes back; "this is" becomes ". This is" — which is why a rule
// that only understood prefix growth duplicated nearly the whole sentence. The
// gaps are wide because the mic was stopped and restarted mid-sentence.
const longDictation = [
  'testing with a longer dictation window',
  'testing with a longer dictation window if I stop and start',
  'testing with a longer dictation window if I stop and start it continue',
  'testing with a longer dictation window if I stop and start, it continues to add extra',
  'testing with a longer dictation window if I stop and start, it continues to add extra this is',
  'testing with a longer dictation window if I stop and start it continues to add extra this is not how',
  'testing with a longer dictation window if I stop and start, it continues to add extra this is not how it',
  "testing with a longer dictation window if I stop and start it continues to add extra. This is not how it's supposed to work.",
  "testing with a longer dictation window if I stop and start it continues to add extra. This is not how it's supposed to work.",
];
ok &= run('long dictation with mid-sentence revisions',
  longDictation.map((s, i) => [s, i * 2500]),
  longDictation[longDictation.length - 1]);

ok &= run('re-capitalising the first word is a revision, not a new phrase',
  [['hello world', 0], ['Hello world.', 800]], 'Hello world.');

ok &= run('an unrelated phrase is never diffed against the last one',
  [['hello world', 0], ['goodbye', 800]], 'hello worldgoodbye');

ok &= run('a phrase resumed after a long pause still coalesces',
  [['testing one', 0], ['testing one two', 20000]], 'testing one two');

// Dictation commits a trailing space or full stop as its own one-character
// chunk. Treating that as "a key was pressed, the phrase is over" is what let
// the mic-off echo back in as a duplicate on long sentences.
ok &= run('trailing space committed separately, then the mic-off echo',
  [['hello world', 0], [' ', 400], ['hello world', 4000]], 'hello world ');

ok &= run('trailing full stop committed separately, then the mic-off echo',
  [['hello world', 0], ['.', 400], ['hello world.', 4000]], 'hello world.');

// Speech with pauses in it: the gap before the mic is switched off can be far
// longer than any plausible "same phrase" timeout, which is why the clock is not
// what decides this.
ok &= run('mic-off echo a full minute after the last snapshot',
  [['this is a long dictation with pauses', 0],
   ['this is a long dictation with pauses', 60000]], 'this is a long dictation with pauses');

ok &= run('a typed character is kept, and does not become part of a later phrase',
  [['hello world', 0], ['!', 200], ['goodbye', 3000]], 'hello world!goodbye');

ok &= run('Enter still closes the phrase across a committed space',
  [['hello world', 0], [' ', 400], ['\r', 900], ['hello world', 1500]],
  'hello world \rhello world');

// Second iPad trace. Every duplicate in it landed exactly where iOS re-recognised
// a word — "Dicked" -> "dictating", "dupe" -> "duplicating", "button" -> "buttom"
// — none of which survive any normalisation, which is why the same-words test
// alone let all three through as new phrases.
const wordRevisions = [
  "i'm Dicked",
  "i'm dictating this sentence with natural pauses when I'm talking and trying to find out how and why things are dupe",
  "i'm dictating this sentence with natural pauses when I'm talking and trying to find out how and why things are duplicating for a long sentence after I turn off the dictation button",
  "i'm dictating this sentence with natural pauses when I'm talking and trying to find out how and why things are duplicating for a long sentence after I turn off the dictation buttom",
];
ok &= run('long dictation with re-recognised words',
  wordRevisions.map((s, i) => [s, i * 3000]),
  wordRevisions[wordRevisions.length - 1]);

// The guard that keeps the loose rule honest: an unrelated phrase keeps almost
// nothing of what was sent, so it is appended rather than rewritten over.
ok &= run('a short unrelated phrase is not rewritten over',
  [['hello world', 0], ['goodbye', 500]], 'hello worldgoodbye');

ok &= run('a long unrelated phrase is not rewritten over',
  [['the quick brown fox jumps over the lazy dog', 0],
   ['completely different sentence entirely', 500]],
  'the quick brown fox jumps over the lazy dogcompletely different sentence entirely');

// Typing after dictation has finished must be untouchable. A character that
// lands seconds later is a person, not dictation committing its final full
// stop, and sweeping it into the phrase leaves it exposed to a later rewrite.
ok &= run('typing well after dictation closes the phrase',
  [['hello world', 0], ['x', 8000], ['y', 8300], ['z', 8600]], 'hello worldxyz');

ok &= run('an echo cannot rewrite characters typed after the phrase',
  [['hello world', 0], ['x', 8000], ['hello world', 9000]], 'hello worldx');

// Mouse reports. The pane has mouse tracking on, so a touch or drag on the iPad
// emits these through the same callback speech arrives on. They are never
// dictation, and must pass through untouched.
const MOVE1 = '\x1b[<35;150;37m';
const MOVE2 = '\x1b[<35;51;38m';
const MOVE3 = '\x1b[<35;131;36m';

ok &= run('mouse reports are never rewritten into each other',
  [[MOVE1, 0], [MOVE2, 100], [MOVE3, 200]], MOVE1 + MOVE2 + MOVE3);

// Reaching for the microphone button drags across the screen. Before this, that
// replaced the phrase and the echo behind it duplicated.
ok &= run('a drag towards the mic button does not break the echo suppression',
  [['hello world', 0], [MOVE1, 500], [MOVE2, 600], ['hello world', 3000]],
  'hello world' + MOVE1 + MOVE2);

ok &= run('a mouse report mid-dictation does not split the phrase',
  [['hello', 0], [MOVE1, 200], ['hello world', 600]], 'hello' + MOVE1 + ' world');

ok &= run('typing after mouse reports is untouched',
  [['hello world', 0], [MOVE1, 500], ['x', 8000], ['y', 8300], ['z', 8600]],
  'hello world' + MOVE1 + 'xyz');

// A click can move the cursor, so unlike motion it ends the phrase.
ok &= run('a mouse click ends the phrase',
  [['hello world', 0], ['\x1b[<0;10;5M', 500], ['hello world', 3000]],
  'hello world' + '\x1b[<0;10;5M' + 'hello world');

ok &= run('an arrow key ends the phrase',
  [['hello world', 0], ['\x1b[A', 500], ['hello world', 3000]],
  'hello world' + '\x1b[A' + 'hello world');

// The captured tap, verbatim from the trace that first showed mouse-report
// garbage in the pane: focus returns, one motion report, then press and release
// of button 0. Every byte must reach the pane exactly as it arrived.
//
// What went wrong originally was not that these were sent — it was that they
// were treated as speech. Consecutive reports share the "ESC[<35;" prefix, so
// one was "corrected" into the next, and the leading DEL ate the ESC. What
// reached herdr was then "<35;150;37M" as plain text, which is precisely what
// appeared on screen: a control sequence is invisible, a control sequence
// missing its ESC is not.
ok &= run('a captured tap passes through byte for byte',
  [['hello world', 0],
   ['\x1b[I', 5000],
   ['\x1b[<35;150;37M', 5041],
   ['\x1b[<0;150;37M', 5099],
   ['\x1b[<0;150;37m', 5129]],
  'hello world\x1b[I\x1b[<35;150;37M\x1b[<0;150;37M\x1b[<0;150;37m');

// And the burst coalescer must not reorder them: a report arriving while a
// buffered burst is still waiting has to land after that burst, not in front of
// it. Out-of-order mouse input is worse than none.
ok &= run('a mouse report does not jump ahead of a buffered burst',
  [['hello', 0], [' ', 3000], ['world', 3018], ['\x1b[<0;10;5M', 3036]],
  'hello world\x1b[<0;10;5M');

// Third iPad trace. iOS deleted a word from the MIDDLE of a sentence it had
// already sent -- "between this sentences" -> "between sentences" -> "between
// or" -- so agreement stopped at character 52 of 192 even though 95% of the
// sentence was untouched. A prefix ratio cannot see that; a subsequence can.
const midSentenceDeletions = [
  "OK, I'm dictating now again and I'm pausing between this sentences or I'm talking fast and not letting it catch up",
  "OK, I'm dictating now again and I'm pausing between sentences or I'm talking fast and not letting it catch up but now I'm going to stop dictating turn off the microphone and type lowercase XYZ",
  "OK, I'm dictating now again and I'm pausing between  or I'm talking fast and not letting it catch up but now I'm going to stop dictating turn off the microphone and type lowercase XYZ",
];
ok &= run('long dictation with mid-sentence word deletions',
  midSentenceDeletions.map((s, i) => [s, i * 4000]),
  midSentenceDeletions[midSentenceDeletions.length - 1]);

ok &= run('typing after that trace is untouched',
  midSentenceDeletions.map((s, i) => [s, i * 4000])
    .concat([['x', 20000], ['y', 20300], ['z', 20600]]),
  midSentenceDeletions[midSentenceDeletions.length - 1] + 'xyz');

// Two sentences on the same subject share plenty of words; the measure still has
// to call them different utterances.
ok &= run('a separate thought on the same topic is not rewritten over',
  [['this is a test of dictation', 0], ['another completely separate thought here', 900]],
  'this is a test of dictationanother completely separate thought here');

// Fourth iPad trace. Both failures lived in the single-character path.
//
// Dictation commits its trailing space when the speaker STOPS, so pausing before
// reaching for the microphone puts it well past any "must land promptly" window.
// A 1500ms one closed the phrase moments before the echo, every single time.
ok &= run('trailing space committed after a long pause, then the echo',
  [['now it is duplicating completely every time I turn off the microphone', 0],
   [' ', 9000],
   ['now it is duplicating completely every time I turn off the microphone', 11000]],
  'now it is duplicating completely every time I turn off the microphone ');

// The same sentence opened with the single letter "O", which could not start a
// phrase, so the sentence behind it arrived as new speech and duplicated.
ok &= run('a phrase that opens with a lone character',
  [['O', 0], ["OK, that didn't work.", 400], ["OK, that didn't work. Let's try again.", 900]],
  "OK, that didn't work. Let's try again.");

// Tail ownership, both ways round. Dictation's own trailing character comes back
// inside the next snapshot and must not be typed twice...
ok &= run('a committed full stop is not doubled when the phrase grows',
  [['hello world', 0], ['.', 200], ['hello world. And more', 2000]],
  'hello world. And more');

// ...while a keystroke never does, and must survive the correction.
ok &= run('a typed character survives a correction and stays at the end',
  [['hello world', 0], ['x', 2000], ['hello world and more', 4000]],
  'hello world and morex');

// The drop rule has to leave fast speech alone. Two cumulative snapshots inside
// the burst window are two chunks and zero fragments — each restates the other,
// so nothing is joined — and the second must still be delivered. Dropping it
// would lose the last words of a sentence with no later snapshot to repair
// them, which is the one failure mode this whole file is arranged to avoid.
ok &= run('two snapshots arriving inside the burst window are not mistaken for a replay',
  [['hello world', 0], ['hello world and', 2000], ['hello world and then some', 2040]],
  'hello world and then some');

// And the replay itself, in miniature: the shortest burst that can exist is
// three chunks and two joins, and it must still be recognised and dropped.
ok &= run('a three-chunk replay of a short phrase is dropped',
  [['hello world', 0],
   ['hello', 3000], [' ', 3018], ['world', 3036]],
  'hello world');

ok &= run('several typed characters all survive a correction',
  [['hello', 0], ['a', 1000], ['b', 1400], ['hello there', 3000]], 'hello thereab');

// The captured trace, replayed chunk for chunk at its recorded timings. This is
// the case no amount of reasoning about rendered output found: at mic-off iOS
// re-sends the whole sentence word by word, and every one of those words is a
// fragment with nothing in common with the phrase held against it.
{
  const trace = require('./testdata/herdr-dictation-trace.json');
  ok &= run('captured trace: word-by-word replay at mic-off',
    trace.chunks.map(([t, c]) => [c, t]), trace.finalText);
}

Date.now = Date_now;
console.log(ok ? '\nall passed' : '\nFAILURES');
process.exit(ok ? 0 : 1);
