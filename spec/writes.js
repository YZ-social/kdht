import process from 'node:process';
import { spawn } from 'node:child_process'; // For optionally spawning bots.js

export function launchWriteRead(nWrites, waitBeforeRead, verbose = false) {
  const args = ['jasmine', 'spec/dhtWriteRead.js', '--', '--nWrites', nWrites, '--waitBeforeRead', waitBeforeRead, '--verbose', verbose];
  const bots = spawn('npx', args, {shell: process.platform === 'win32'});
  console.log(new Date(), 'spawning npx', args.join(' '));
  function echo(data) { data = data.slice(0, -1); console.log(data.toString()); }
  bots.stdout.on('data', echo);
  bots.stderr.on('data', echo);
}
