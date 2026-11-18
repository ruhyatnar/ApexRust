// Minimal interactive prompts on a single shared readline interface (Node built-ins only).
import readline from 'node:readline';

let rl = null;
let muted = false;
let nonInteractive = false;
const queuedLines = [];
const waiters = [];

export function setNonInteractive(value) {
  nonInteractive = Boolean(value);
}

export function isInteractive() {
  return !nonInteractive && Boolean(process.stdin.isTTY);
}

function ensureRl() {
  if (rl) return rl;
  rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  rl._writeToOutput = (s) => {
    if (!muted) {
      process.stdout.write(s);
    } else if (s.includes('\n') || s.includes('\r')) {
      process.stdout.write('\n');
    }
  };
  rl.on('line', (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else queuedLines.push(line);
  });
  rl.on('close', () => {
    while (waiters.length > 0) waiters.shift()('');
  });
  return rl;
}

function ask(question, { secret = false } = {}) {
  ensureRl();
  process.stdout.write(question);
  muted = secret;
  return new Promise((resolve) => {
    const done = (line) => {
      muted = false;
      resolve(line);
    };
    if (queuedLines.length > 0) done(queuedLines.shift());
    else waiters.push(done);
  });
}

export function closePrompts() {
  if (rl) {
    rl.close();
    rl = null;
  }
}

const c = {
  bold: (s) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s),
  dim: (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s),
};

/** Numbered single choice. `options` = [{ value, label }]. Returns the chosen value. */
export async function select(question, options, defaultValue) {
  const defaultIdx = Math.max(0, options.findIndex((o) => o.value === defaultValue));
  if (!isInteractive()) return options[defaultIdx].value;
  console.log(`\n${c.bold(question)}`);
  options.forEach((o, i) => console.log(`  ${i + 1}) ${o.label}${i === defaultIdx ? c.dim('  (default)') : ''}`));
  for (;;) {
    const answer = (await ask(`Choose [1-${options.length}, Enter = ${defaultIdx + 1}]: `)).trim();
    if (answer === '') return options[defaultIdx].value;
    const n = Number(answer);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1].value;
    console.log('  Please enter a number from the list.');
  }
}

export async function confirm(question, defaultYes = false) {
  if (!isInteractive()) return defaultYes;
  const hint = defaultYes ? 'Y/n' : 'y/N';
  for (;;) {
    const answer = (await ask(`${question} [${hint}]: `)).trim().toLowerCase();
    if (answer === '') return defaultYes;
    if (['y', 'yes'].includes(answer)) return true;
    if (['n', 'no'].includes(answer)) return false;
  }
}

/** Free text with default and optional validator returning null/''/true when valid or an error string. */
export async function input(question, defaultValue = '', validate) {
  if (!isInteractive()) return defaultValue;
  for (;;) {
    const shown = defaultValue !== '' ? ` [${defaultValue}]` : '';
    const raw = (await ask(`${question}${shown}: `)).trim();
    const value = raw === '' ? defaultValue : raw;
    const err = validate ? validate(value) : null;
    if (err === undefined || err === null || err === '' || err === true) return value;
    console.log(`  ${err === false ? 'Invalid input.' : err}`);
  }
}

/** Masked input. Enter keeps the existing value (if any). */
export async function secret(question, hasExisting = false) {
  if (!isInteractive()) return null;
  const hint = hasExisting ? ' [Enter = keep existing]' : ' [Enter = skip]';
  const raw = (await ask(`${question}${hint}: `, { secret: true })).trim();
  return raw === '' ? null : raw;
}
