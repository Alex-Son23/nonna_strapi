'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const createUploadMiddleware = require('./validate-upload');

const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00]),
  Buffer.alloc(4100),
]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(4100),
]);

async function withUploadFile({ name, type, contents }, callback) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nonna-upload-validation-'));
  const filePath = path.join(directory, 'upload.tmp');
  await fs.writeFile(filePath, contents);

  try {
    return await callback({ name, type, path: filePath, size: contents.length });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function runMiddleware(routePath, file) {
  let nextCalled = false;
  let rejection;
  const ctx = {
    path: routePath,
    request: { files: { files: file } },
    badRequest(message) {
      rejection = message;
      this.status = 400;
    },
  };

  await createUploadMiddleware({}, { strapi: {} })(ctx, async () => {
    nextCalled = true;
  });

  return { nextCalled, rejection, status: ctx.status };
}

test('accepts JPEG and PNG signatures on both upload entry points before continuing', async () => {
  for (const [routePath, file] of [
    ['/upload', { name: 'photo.JPG', type: 'image/jpeg', contents: JPEG }],
    ['/api/upload', { name: 'floor.png', type: 'image/png', contents: PNG }],
  ]) {
    const result = await withUploadFile(file, (upload) => runMiddleware(routePath, upload));
    assert.deepEqual(result, { nextCalled: true, rejection: undefined, status: undefined });
  }
})

test('rejects HTML and SVG uploads even when client metadata claims an image', async () => {
  for (const file of [
    { name: 'attack.jpg', type: 'image/jpeg', contents: Buffer.from('<!doctype html><script>alert(1)</script>') },
    { name: 'attack.svg', type: 'image/svg+xml', contents: Buffer.from('<svg onload="alert(1)"></svg>') },
  ]) {
    const result = await withUploadFile(file, (upload) => runMiddleware('/upload', upload));
    assert.equal(result.nextCalled, false);
    assert.equal(result.status, 400);
    assert.match(result.rejection, /not an allowed JPEG or PNG/i);
  }
})

test('rejects unsupported extensions, MIME mismatches and signature mismatches', async () => {
  for (const file of [
    { name: 'photo.gif', type: 'image/png', contents: PNG },
    { name: 'photo.png', type: 'image/jpeg', contents: PNG },
    { name: 'photo.jpg', type: 'image/jpeg', contents: PNG },
    { name: 'photo.png', type: 'image/png', contents: JPEG },
  ]) {
    const result = await withUploadFile(file, (upload) => runMiddleware('/api/upload', upload));
    assert.equal(result.nextCalled, false, file.name);
    assert.equal(result.status, 400, file.name);
    assert.match(result.rejection, /does not match|unsupported extension/i, file.name);
  }
})

test('validates every file in a multi-file upload before continuing', async () => {
  await withUploadFile(
    { name: 'safe.jpg', type: 'image/jpeg', contents: JPEG },
    async (safeUpload) => withUploadFile(
      { name: 'unsafe.jpg', type: 'image/jpeg', contents: Buffer.from('<html>bad</html>') },
      async (unsafeUpload) => {
        const result = await runMiddleware('/upload', [safeUpload, unsafeUpload]);
        assert.equal(result.nextCalled, false);
        assert.equal(result.status, 400);
      },
    ),
  );
})
