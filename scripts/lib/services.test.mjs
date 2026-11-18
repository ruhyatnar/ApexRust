import test from 'node:test';
import assert from 'node:assert/strict';
import {
  launchdLabel,
  renderLaunchdPlist,
  renderSystemdUnit,
  renderWindowsTaskScript,
  systemdUnitName,
  windowsTaskName,
} from './services.mjs';

test('renderSystemdUnit renders valid user and system unit files', () => {
  const userUnit = renderSystemdUnit({
    component: 'web',
    repoDir: '/home/dev/Apex Rust',
    nodePath: '/usr/local/bin/node',
    system: false,
    pathEnv: '/usr/bin:%h/.cargo/bin',
  });
  assert.equal(systemdUnitName('web'), 'apexrust-web.service');
  assert.match(userUnit, /ExecStart="\/usr\/local\/bin\/node" "\/home\/dev\/Apex Rust\/scripts\/apexrust\.mjs" run web/);
  assert.match(userUnit, /Environment="PATH=\/usr\/bin:%%h\/\.cargo\/bin"/);
  assert.match(userUnit, /WantedBy=default\.target/);
  assert.doesNotMatch(userUnit, /^User=/m);

  const sysUnit = renderSystemdUnit({
    component: 'bot',
    repoDir: '/opt/apexrust',
    nodePath: '/usr/bin/node',
    system: true,
    user: 'apex',
  });
  assert.match(sysUnit, /User=apex/);
  assert.match(sysUnit, /NoNewPrivileges=true/);
  assert.match(sysUnit, /WantedBy=multi-user\.target/);
});

test('renderLaunchdPlist escapes XML special chars and configures RunAtLoad', () => {
  const plist = renderLaunchdPlist({
    component: 'bot',
    repoDir: '/Users/dev/Apex&Rust',
    nodePath: '/opt/homebrew/bin/node',
    logPath: '/Users/dev/Apex&Rust/.apexrust/logs/bot.log',
  });
  assert.equal(launchdLabel('bot'), 'com.apexrust.bot');
  assert.match(plist, /<string>com\.apexrust\.bot<\/string>/);
  assert.match(plist, /Apex&amp;Rust\/scripts\/apexrust\.mjs/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
});

test('renderWindowsTaskScript targets hidden PowerShell running apexrust.mjs with --log', () => {
  const ps1 = renderWindowsTaskScript({
    component: 'web',
    repoDir: "C:\\Users\\O'Brien\\ApexRust",
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    logPath: "C:\\Users\\O'Brien\\ApexRust\\.apexrust\\logs\\web.log",
  });
  assert.equal(windowsTaskName('web'), 'ApexRust-Web');
  assert.match(ps1, /Register-ScheduledTask -TaskName 'ApexRust-Web'/);
  assert.match(ps1, /--log/);
  assert.match(ps1, /O''Brien/);
});
