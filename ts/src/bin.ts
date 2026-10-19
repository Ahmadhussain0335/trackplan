import { runCli } from './cli.js';

process.exitCode = runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  out: process.stdout,
  err: process.stderr,
});
