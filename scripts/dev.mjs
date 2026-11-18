// Runs the game server (5421) and the Vite client (5420) together for local development.
import { spawn } from 'node:child_process';
const procs = [
  spawn('npm', ['run', 'dev', '-w', '@blockshore/server'], { stdio: 'inherit', shell: true }),
  spawn('npm', ['run', 'dev', '-w', '@blockshore/client'], { stdio: 'inherit', shell: true }),
];
const stop = () => { for (const p of procs) p.kill('SIGTERM'); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
