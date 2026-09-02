'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  descriptionToHtml,
  normalizeInstagram,
  normalizeOptional,
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
