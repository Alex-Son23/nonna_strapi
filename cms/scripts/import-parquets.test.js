'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  publicationData,
  sortSourceImages,
  validateCatalog,
} = require('./import-parquets');

const catalog = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'content', 'parquets.json'), 'utf8')
);

test('catalog contains complete Russian and English parquet data', () => {
  const summary = validateCatalog(catalog);

  assert.deepEqual(summary, {
    products: 33,
    uniqueProducts: 31,
    uniqueSourceFolders: 31,
    countries: 1,
    woods: 4,
    colors: 9,
    coatings: 2,
  });

  for (const product of catalog.products) {
    assert.ok(product.name.ru, `${product.key} has a Russian name`);
    assert.ok(product.name.en, `${product.key} has an English name`);
  }
});

test('only the two cross-collection products have duplicate media', () => {
  const productsByMedia = new Map();
  for (const product of catalog.products) {
    const products = productsByMedia.get(product.mediaKey) || [];
    products.push(product);
    productsByMedia.set(product.mediaKey, products);
  }
  const duplicates = [...productsByMedia.entries()]
    .filter(([, products]) => products.length > 1)
    .map(([mediaKey, products]) => ({
      mediaKey,
      woods: products.map((product) => product.wood).sort(),
    }));

  assert.deepEqual(duplicates, [
    {
      mediaKey: 'planed-thermo-oak',
      woods: ['hand-finished', 'thermo-oak'],
    },
    {
      mediaKey: 'distressed-bevel-thermo-oak',
      woods: ['hand-finished', 'thermo-oak'],
    },
  ]);
});

test('source images are ordered deterministically for the main image and gallery', () => {
  assert.deepEqual(
    sortSourceImages([
      { name: 'Jenny светлый_2.png.png' },
      { name: 'Jenny светлый_1.png.png' },
      { name: 'Jenny светлый_2.png' },
    ]).map((file) => file.name),
    [
      'Jenny светлый_1.png.png',
      'Jenny светлый_2.png',
      'Jenny светлый_2.png.png',
    ]
  );

  assert.deepEqual(
    sortSourceImages([
      { name: 'Белое масло_2.png' },
      { name: 'Белое масло.png' },
      { name: 'Белое масло_1.png' },
    ]).map((file) => file.name),
    ['Белое масло.png', 'Белое масло_1.png', 'Белое масло_2.png']
  );
});

test('repeat publishing preserves the original publication date', () => {
  const publishedAt = new Date('2026-09-02T00:00:00.000Z');

  assert.equal(publicationData(true, publishedAt).publishedAt, publishedAt);
  assert.ok(publicationData(true).publishedAt instanceof Date);
  assert.deepEqual(publicationData(false, publishedAt), {});
});
