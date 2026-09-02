'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  descriptionToHtml,
  normalizeInstagram,
  normalizeOptional,
  prepareUploadSource,
  selectProjectImages,
  validateCatalog,
  validateMediaTree,
} = require('./import-projects');

const catalog = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'content', 'projects.json'), 'utf8')
);
const mediaDir = path.resolve(__dirname, '..', '..', 'projects-review');

test('catalog contains the approved Russian and English project data', () => {
  const summary = validateCatalog(catalog);

  assert.deepEqual(summary, {
    projects: 14,
    propertyTypes: 3,
    countries: 1,
  });
});

test('review folders contain all approved project images', async () => {
  const summary = await validateMediaTree(catalog, mediaDir);

  assert.deepEqual(summary, {
    projects: 14,
    images: 125,
    oversizedImages: 9,
    largeDimensionImages: 42,
  });
});

test('named cover is used as the main image and is removed from the gallery', () => {
  const selection = selectProjectImages([
    '02_room.jpg',
    '11_Обложка.jpg',
    '01_room.jpg',
  ]);

  assert.equal(selection.cover, '11_Обложка.jpg');
  assert.deepEqual(selection.gallery, ['01_room.jpg', '02_room.jpg']);
});

test('first image is used when a project has no named cover', () => {
  const selection = selectProjectImages(['10_room.jpg', '02_room.jpg', '01_room.jpg']);

  assert.equal(selection.cover, '01_room.jpg');
  assert.deepEqual(selection.gallery, ['02_room.jpg', '10_room.jpg']);
});

test('plain descriptions become safe CKEditor paragraphs', () => {
  assert.equal(
    descriptionToHtml('Первый абзац.\n\nВторой абзац.\nНовая строка.'),
    '<p>Первый абзац.</p><p>Второй абзац.<br>Новая строка.</p>'
  );
  assert.equal(descriptionToHtml('<описание в переписке отсутствует>'), null);
  assert.equal(descriptionToHtml('A < B & C'), '<p>A &lt; B &amp; C</p>');
});

test('optional placeholders are empty and Instagram URLs become handles', () => {
  assert.equal(normalizeOptional('<не указан>'), null);
  assert.equal(normalizeOptional('<not provided>'), null);
  assert.equal(normalizeOptional('Дизайнер'), 'Дизайнер');
  assert.equal(
    normalizeInstagram('https://www.instagram.com/zoomroom_design?igsh=value'),
    'zoomroom_design'
  );
  assert.equal(normalizeInstagram('@kurilovdesign'), 'kurilovdesign');
});

test('large source photos are reduced to a web-safe resolution', async () => {
  const temporaryDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nonna-project-test-'));
  try {
    const sources = [
      ['Частная квартира в Санкт-Петербурге. ЖК Биография', '01_1.jpg'],
      ['Квартира в Санкт-Петербурге, ЖК Маленькая Франция', '02_2.jpg'],
      ['Квартира в Санкт-Петербурге, ЖК Богемия — Zoom Room', '01_1.JPG'],
    ];
    for (const [index, [folder, file]] of sources.entries()) {
      const sourcePath = path.join(mediaDir, folder, 'images', file);
      const outputPath = path.join(temporaryDir, `prepared-${index}.jpg`);
      const preparedPath = await prepareUploadSource(sourcePath, outputPath);
      const [metadata, stat] = await Promise.all([
        require('sharp')(preparedPath).metadata(),
        fsp.stat(preparedPath),
      ]);
      assert.ok(Math.max(metadata.width, metadata.height) <= 3200);
      assert.ok(stat.size <= 15 * 1024 * 1024);
    }
  } finally {
    await fsp.rm(temporaryDir, { recursive: true, force: true });
  }
});
