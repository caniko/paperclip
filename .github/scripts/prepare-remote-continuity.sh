#!/usr/bin/env bash
set -euo pipefail
test "$RUNNER_ENVIRONMENT" = github-hosted
test "$GITHUB_RUN_ATTEMPT" = 1
EVIDENCE="$(realpath "$1")"
ROOT="$(git rev-parse --show-toplevel)"
FIXTURE="$(mktemp -d "$RUNNER_TEMP/remote-continuity.XXXXXXXX")"
IMAGE='node:24-trixie@sha256:a3e43f3f15bea8c59c689afeebe63c945885677ae469ae8d12578567ef18f1df'
export EVIDENCE FIXTURE IMAGE
umask 077
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$FIXTURE/test.key" -out "$FIXTURE/test.crt" \
  -days 1 -subj '/CN=localhost' -addext 'subjectAltName=IP:127.0.0.1,DNS:localhost'
cat > "$FIXTURE/fake-codex" <<'WRAPPER'
#!/bin/sh
if [ "$1" = '--version' ]; then
  echo 'codex-cli 0.999.0'
  exit 0
fi
exec /opt/continuity/fake-codex-app-server \
  --state-file-in-codex-home --durable-turn-ids --record-process-start \
  --call-log "$PWD/provider-calls.log" "$@"
WRAPPER
chmod 755 "$FIXTURE/fake-codex"
docker pull "$IMAGE"
docker run --detach --init --cidfile "$EVIDENCE/remote-continuity-container.id" \
  --label "paperclip.qualification.run=$GITHUB_RUN_ID" \
  --publish 127.0.0.1::43127 "$IMAGE" sleep infinity
CONTAINER="$(cat "$EVIDENCE/remote-continuity-container.id")"
export CONTAINER
docker exec "$CONTAINER" sh -eu -c 'for tool in node sh tar base64 ps setsid sha256sum; do command -v "$tool"; done; mkdir -p /opt/continuity'
docker cp "$ROOT/packages/paperclip-runner/runner/target/release/fake-codex-app-server" "$CONTAINER:/opt/continuity/fake-codex-app-server"
node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
const { EVIDENCE, FIXTURE, IMAGE, CONTAINER } = process.env;
const command = (program, args) => execFileSync(program, args, { encoding: 'utf8', timeout: 30_000 }).trim();
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const inspection = JSON.parse(command('docker', ['inspect', CONTAINER]))[0];
assert.equal(inspection.Config.Image, IMAGE);
assert.equal(inspection.State.Running, true);
assert.equal(inspection.Config.Labels['paperclip.qualification.run'], process.env.GITHUB_RUN_ID);
const [port] = inspection.NetworkSettings.Ports['43127/tcp'];
assert.equal(port.HostIp, '127.0.0.1');
const runner = path.resolve('packages/paperclip-runner/runner/target/release/paperclip-runnerd');
const provider = path.resolve('packages/paperclip-runner/runner/target/release/fake-codex-app-server');
const remoteProvider = '/opt/continuity/fake-codex-app-server';
assert.equal(command('docker', ['exec', CONTAINER, 'sha256sum', remoteProvider]).split(/\s/)[0], hash(provider));
const tools = command('docker', ['exec', CONTAINER, 'sh', '-eu', '-c', 'for tool in node sh tar base64 ps setsid; do sha256sum "$(command -v "$tool")"; done']);
const receipt = { schema: 'paperclip.remote-continuity.v1', head: command('git', ['rev-parse', 'HEAD']),
  runId: process.env.GITHUB_RUN_ID, runAttempt: 1, container: CONTAINER, image: IMAGE, imageId: inspection.Image,
  runner: { binary: runner, sha256: hash(runner) }, provider: { binary: provider, remote: remoteProvider, sha256: hash(provider) },
  wrapper: { binary: path.join(FIXTURE, 'fake-codex'), sha256: hash(path.join(FIXTURE, 'fake-codex')) },
  certificate: { binary: path.join(FIXTURE, 'test.crt'), sha256: hash(path.join(FIXTURE, 'test.crt')) },
  port: port.HostPort, tools, nodeVersion: command('docker', ['exec', CONTAINER, 'node', '--version']),
  helperSha256: hash('.github/scripts/prepare-remote-continuity.sh'), producerAcceptanceQualified: false };
writeFileSync(path.join(EVIDENCE, 'remote-continuity.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
const environment = { NODE_EXTRA_CA_CERTS: receipt.certificate.binary, PAPERCLIP_TEST_RUNNER_TLS_KEY: path.join(FIXTURE, 'test.key'),
  PAPERCLIP_TEST_RUNNER_CONTAINER: CONTAINER, PAPERCLIP_TEST_RUNNER_PORT: port.HostPort,
  PAPERCLIP_TEST_LINUX_RUNNER_BINARY: runner, PAPERCLIP_TEST_FAKE_CODEX_WRAPPER: receipt.wrapper.binary };
assert.ok(Object.values(environment).every(value => !/[\r\n]/.test(value)));
appendFileSync(process.env.GITHUB_ENV, Object.entries(environment).map(([name, value]) => `${name}=${value}\n`).join(''));
NODE
