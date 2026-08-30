'use strict';

const path = require('node:path');

const ALLOWED_UPLOADS = Object.freeze({
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
});

let fileTypeModule;

async function detectFileType(filePath) {
  fileTypeModule ||= import('file-type');
  const { fileTypeFromFile } = await fileTypeModule;
  return fileTypeFromFile(filePath);
}

async function validateUploadFile(file) {
  const name = file && file.name;
  const extension = path.extname(name || '').toLowerCase();
  const expectedMime = ALLOWED_UPLOADS[extension];

  if (!expectedMime) {
    throw new Error(`Upload ${name || '<unnamed>'} is not an allowed JPEG or PNG: unsupported extension`);
  }

  if (file.type !== expectedMime) {
    throw new Error(`Upload MIME type does not match the ${extension} extension`);
  }

  if (!file.path) {
    throw new Error('Upload has no temporary file path');
  }

  let detected;
  try {
    detected = await detectFileType(file.path);
  } catch (_error) {
    detected = undefined;
  }
  if (!detected || detected.mime !== expectedMime) {
    throw new Error(`Upload is not an allowed JPEG or PNG; signature does not match the declared ${expectedMime} type`);
  }
}

module.exports = (_config, _context) => async (ctx, next) => {
  const uploaded = ctx.request && ctx.request.files && ctx.request.files.files;
  if (!uploaded) {
    return next();
  }

  const files = Array.isArray(uploaded) ? uploaded : [uploaded];
  try {
    for (const file of files) {
      await validateUploadFile(file);
    }
  } catch (error) {
    return ctx.badRequest(error.message);
  }

  return next();
};

module.exports.validateUploadFile = validateUploadFile;
