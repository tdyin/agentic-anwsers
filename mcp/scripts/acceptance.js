import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// Own only the randomly named test container and its anonymous SQLite volume.
const name = `agentic-acceptance-${randomBytes(6).toString('hex')}`;
const directory = mkdtempSync(join(tmpdir(), 'agentic-acceptance-'));
const envFile = join(directory, 'install.env');
const adminPassword = randomBytes(12).toString('hex');
writeFileSync(envFile, [
  'AUTO_INSTALL=true', 'DB_TYPE=sqlite3', 'DB_FILE=/data/answer.db',
  'LANGUAGE=en_US', 'SITE_NAME=Acceptance', 'SITE_URL=http://localhost',
  'CONTACT_EMAIL=owner@example.com', 'ADMIN_NAME=Owner',
  'ADMIN_EMAIL=owner@example.com', `ADMIN_PASSWORD=${adminPassword}`,
  'EXTERNAL_CONTENT_DISPLAY=always_display', '',
].join('\n'), { mode: 0o600 });
// Pin the chosen host port: Docker can reassign an ephemeral mapping on restart.
const reservation = createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const hostPort = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
let created = false;
try {
  execFileSync('docker', ['run', '-d', '--name', name, '-p', `127.0.0.1:${hostPort}:80`,
    '--env-file', envFile, 'apache/answer:2.0.2'], { stdio: 'pipe' });
  created = true;
  const port = execFileSync('docker', ['inspect', '--format', '{{(index (index .NetworkSettings.Ports "80/tcp") 0).HostPort}}', name], { encoding: 'utf8' }).trim();
  const baseUrl = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      // The installer also has healthz; wait for the application API instead.
      const response = await fetch(`${baseUrl}/answer/api/v1/siteinfo`, { signal: AbortSignal.timeout(1000) });
      ready = response.ok && (await response.json()).code === 200;
    } catch {}
    if (ready) break;
    await delay(500);
  }
  if (!ready) throw new Error('Disposable Answer instance did not become ready.');
  const result = spawnSync(process.execPath, ['--test', 'test/answer-acceptance.test.js'], {
    cwd: new URL('..', import.meta.url), stdio: 'inherit',
    env: { ...process.env, ACCEPTANCE_ANSWER_URL: baseUrl, ACCEPTANCE_RESTART_CONTAINER: name,
      ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: adminPassword },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  if (created) execFileSync('docker', ['rm', '-f', '-v', name], { stdio: 'pipe' });
  rmSync(directory, { recursive: true, force: true });
}
