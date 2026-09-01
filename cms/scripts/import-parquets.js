'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const CATALOG_PATH = path.join(__dirname, 'content', 'parquets.json');
const DEFAULT_MEDIA_DIR = '/tmp/nonna-parquet-media';
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const IMAGE_WIDTH = 2400;
const IMAGE_QUALITY = 84;

const dictionaryModels = {
  countries: 'api::country.country',
  woods: 'api::wood.wood',
  colors: 'api::color.color',
  coatings: 'api::coating.coating',
};

function loadCatalog() {
  return JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
}

function assertUnique(items, label) {
  if (new Set(items).size !== items.length) {
    throw new Error(`${label} contains duplicate values`);
  }
}

function validateCatalog(catalog) {
  if (!catalog || catalog.version !== 1 || !catalog.source || !catalog.dictionaries) {
    throw new Error('Unsupported or incomplete parquet catalog');
  }
  if (!Array.isArray(catalog.products) || catalog.products.length === 0) {
    throw new Error('Parquet catalog has no products');
  }

  const dictionaries = catalog.dictionaries;
  for (const name of Object.keys(dictionaryModels)) {
    if (!Array.isArray(dictionaries[name]) || dictionaries[name].length === 0) {
      throw new Error(`Dictionary ${name} is missing`);
    }
    assertUnique(dictionaries[name].map((item) => item.key), `${name} keys`);
    assertUnique(dictionaries[name].map((item) => item.ru), `${name} Russian names`);
    assertUnique(dictionaries[name].map((item) => item.en), `${name} English names`);
    for (const item of dictionaries[name]) {
      if (!item.key || !item.ru || !item.en) {
        throw new Error(`Dictionary ${name} contains an incomplete translation`);
      }
    }
  }

  const dictionaryKeys = Object.fromEntries(
    Object.entries(dictionaries).map(([name, items]) => [
      name,
      new Set(items.map((item) => item.key)),
    ])
  );
  const mediaFolders = new Map();

  assertUnique(catalog.products.map((product) => product.key), 'product keys');
  for (const product of catalog.products) {
    if (!product.name?.ru || !product.name?.en || !product.mediaKey || !product.sourceFolder) {
      throw new Error(`Product ${product.key || '<unknown>'} is incomplete`);
    }
    for (const [relation, dictionaryName] of Object.entries({
      country: 'countries',
      wood: 'woods',
      color: 'colors',
      coating: 'coatings',
    })) {
      if (!dictionaryKeys[dictionaryName].has(product[relation])) {
        throw new Error(`${product.key} references unknown ${relation} ${product[relation]}`);
      }
    }
    const knownFolder = mediaFolders.get(product.mediaKey);
    if (knownFolder && knownFolder !== product.sourceFolder) {
      throw new Error(`${product.mediaKey} maps to more than one source folder`);
    }
    mediaFolders.set(product.mediaKey, product.sourceFolder);
  }

  if (new Set(mediaFolders.values()).size !== mediaFolders.size) {
    throw new Error('More than one media key maps to the same source folder');
  }

  return {
    products: catalog.products.length,
    uniqueProducts: new Set(catalog.products.map((product) => product.name.ru)).size,
    uniqueSourceFolders: new Set(catalog.products.map((product) => product.sourceFolder)).size,
    countries: dictionaries.countries.length,
    woods: dictionaries.woods.length,
    colors: dictionaries.colors.length,
    coatings: dictionaries.coatings.length,
  };
}

function sortSourceImages(files) {
  const collator = new Intl.Collator('ru', {
    numeric: true,
    sensitivity: 'base',
  });
  const sequence = (name) => {
    const stem = name.replace(/(?:\.(?:png|jpe?g))+$/gi, '');
    const match = stem.match(/_(\d+)$/);
    return match ? Number(match[1]) : 0;
  };
  return [...files].sort((left, right) => {
    const sequenceDifference = sequence(left.name) - sequence(right.name);
    return sequenceDifference || collator.compare(left.name, right.name);
  });
}

async function fetchYandexFolder(publicKey, folderPath) {
  const url = new URL('https://cloud-api.yandex.net/v1/disk/public/resources');
  url.searchParams.set('public_key', publicKey);
  url.searchParams.set('path', `/${folderPath}`);
  url.searchParams.set('limit', '100');

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Yandex Disk returned ${response.status} for ${folderPath}`);
  }
  const payload = await response.json();
  const files = (payload._embedded?.items || []).filter(
    (item) => item.type === 'file' && item.mime_type?.startsWith('image/')
  );
  if (files.length !== 3) {
    throw new Error(`${folderPath} must contain exactly 3 images, found ${files.length}`);
  }
  return sortSourceImages(files);
}

async function optimizeImage(buffer, outputPath) {
  const sharp = require('sharp');
  await sharp(buffer)
    .rotate()
    .flatten({ background: '#ffffff' })
    .resize({
      width: IMAGE_WIDTH,
      height: IMAGE_WIDTH,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: IMAGE_QUALITY, chromaSubsampling: '4:4:4', mozjpeg: true })
    .toFile(outputPath);

  const stat = await fsp.stat(outputPath);
  if (stat.size > MAX_UPLOAD_BYTES) {
    await sharp(outputPath)
      .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 78, chromaSubsampling: '4:2:0', mozjpeg: true })
      .toFile(`${outputPath}.retry`);
    await fsp.rename(`${outputPath}.retry`, outputPath);
  }

  const finalStat = await fsp.stat(outputPath);
  if (finalStat.size > MAX_UPLOAD_BYTES) {
    throw new Error(`${outputPath} is still larger than 15 MiB after optimization`);
  }
}

async function isReusableJpeg(filePath) {
  try {
    const sharp = require('sharp');
    const [stat, metadata] = await Promise.all([
      fsp.stat(filePath),
      sharp(filePath).metadata(),
    ]);
    return stat.size > 0 && stat.size <= MAX_UPLOAD_BYTES && metadata.format === 'jpeg';
  } catch (_error) {
    return false;
  }
}

async function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

async function prepareMedia(catalog, mediaDir) {
  await fsp.mkdir(mediaDir, { recursive: true });
  const uniqueProducts = [];
  const seenMedia = new Set();
  for (const product of catalog.products) {
    if (!seenMedia.has(product.mediaKey)) {
      seenMedia.add(product.mediaKey);
      uniqueProducts.push(product);
    }
  }

  const prepared = [];
  for (const [productIndex, product] of uniqueProducts.entries()) {
    process.stdout.write(
      `[media ${productIndex + 1}/${uniqueProducts.length}] ${product.sourceFolder}\n`
    );
    const sourceFiles = await fetchYandexFolder(
      catalog.source.yandexPublicKey,
      product.sourceFolder
    );
    const outputs = [];

    for (const [imageIndex, source] of sourceFiles.entries()) {
      const outputName = `nonna-parquet-${product.mediaKey}-${String(imageIndex + 1).padStart(2, '0')}.jpg`;
      const outputPath = path.join(mediaDir, outputName);

      if (!(await isReusableJpeg(outputPath))) {
        if (!source.file) {
          throw new Error(`Yandex Disk did not provide a download URL for ${source.path}`);
        }
        const response = await fetch(source.file);
        if (!response.ok) {
          throw new Error(`Download failed with ${response.status} for ${source.path}`);
        }
        await optimizeImage(Buffer.from(await response.arrayBuffer()), outputPath);
      }

      const sharp = require('sharp');
      const [stat, metadata, checksum] = await Promise.all([
        fsp.stat(outputPath),
        sharp(outputPath).metadata(),
        sha256(outputPath),
      ]);
      outputs.push({
        file: outputName,
        source: source.name,
        bytes: stat.size,
        width: metadata.width,
        height: metadata.height,
        sha256: checksum,
      });
    }
    prepared.push({
      mediaKey: product.mediaKey,
      sourceFolder: product.sourceFolder,
      images: outputs,
    });
  }

  await fsp.writeFile(
    path.join(mediaDir, 'manifest.json'),
    `${JSON.stringify({ version: 1, prepared }, null, 2)}\n`
  );
  return prepared;
}

function parseArgs(argv) {
  const options = {
    prepareMedia: false,
    import: false,
    replace: false,
    publish: false,
    mediaDir: DEFAULT_MEDIA_DIR,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--prepare-media') options.prepareMedia = true;
    else if (argument === '--import') options.import = true;
    else if (argument === '--replace') options.replace = true;
    else if (argument === '--publish') options.publish = true;
    else if (argument === '--media-dir') {
      options.mediaDir = path.resolve(argv[index + 1]);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!options.prepareMedia && !options.import) {
    throw new Error('Specify --prepare-media, --import, or both');
  }
  return options;
}

function publicationData(publish, publishedAt = null) {
  return publish ? { publishedAt: publishedAt || new Date() } : {};
}

async function ensureLocalizedPair(strapi, uid, definition, publish) {
  const query = strapi.db.query(uid);
  let ru = await query.findOne({
    where: { locale: 'ru', name: definition.ru },
    populate: ['localizations'],
  });

  if (!ru) {
    ru = await strapi.entityService.create(uid, {
      data: {
        locale: 'ru',
        name: definition.ru,
        ...publicationData(publish),
      },
      populate: ['localizations'],
    });
  } else {
    ru = await strapi.entityService.update(uid, ru.id, {
      data: { name: definition.ru, ...publicationData(publish, ru.publishedAt) },
      populate: ['localizations'],
    });
  }

  let en = ru.localizations?.find((entry) => entry.locale === 'en');
  if (!en) {
    en = await query.findOne({
      where: { locale: 'en', name: definition.en },
      populate: ['localizations'],
    });
  }
  if (!en) {
    en = await strapi.entityService.create(uid, {
      data: {
        locale: 'en',
        name: definition.en,
        localizations: [ru.id],
        ...publicationData(publish),
      },
      populate: ['localizations'],
    });
  } else {
    en = await strapi.entityService.update(uid, en.id, {
      data: { name: definition.en, ...publicationData(publish, en.publishedAt) },
      populate: ['localizations'],
    });
  }

  await linkLocalizations(strapi, uid, ru.id, en.id);

  return { ru: { ...ru, name: definition.ru }, en: { ...en, name: definition.en } };
}

async function ensureUpload(strapi, filePath, alternativeText) {
  const name = path.basename(filePath);
  const uploadQuery = strapi.db.query('plugin::upload.file');
  const existing = await uploadQuery.findOne({ where: { name } });
  if (existing) {
    const physicalPath = path.join(strapi.dirs.static.public, existing.url.replace(/^\//, ''));
    if (fs.existsSync(physicalPath)) return existing;
    await uploadQuery.delete({ where: { id: existing.id } });
  }

  const stat = await fsp.stat(filePath);
  if (stat.size > MAX_UPLOAD_BYTES) {
    throw new Error(`${name} exceeds the Strapi upload limit`);
  }
  const uploaded = await strapi.plugin('upload').service('upload').upload({
    data: {
      fileInfo: {
        name,
        alternativeText,
        caption: alternativeText,
      },
    },
    files: {
      path: filePath,
      name,
      type: 'image/jpeg',
      size: stat.size,
    },
  });
  if (!uploaded[0]) throw new Error(`Strapi did not return an uploaded file for ${name}`);
  return uploaded[0];
}

async function ensureProductLocale(strapi, product, locale, relations, media, publish) {
  const uid = 'api::parquet.parquet';
  const query = strapi.db.query(uid);
  const name = product.name[locale];
  const candidates = await query.findMany({
    where: { locale, name },
    populate: ['wood', 'localizations'],
  });
  let entry = candidates.find((candidate) => candidate.wood?.id === relations.wood.id);
  const data = {
    locale,
    name,
    image: media[0].id,
    images: media.slice(1).map((file) => file.id),
    country: relations.country.id,
    wood: relations.wood.id,
    color: relations.color.id,
    coating: relations.coating.id,
    size: null,
    description: null,
    type_of_picture: null,
    decor: null,
    ...publicationData(publish, entry?.publishedAt),
  };

  if (!entry) {
    entry = await strapi.entityService.create(uid, {
      data,
      populate: ['wood', 'localizations'],
    });
  } else {
    entry = await strapi.entityService.update(uid, entry.id, {
      data,
      populate: ['wood', 'localizations'],
    });
  }
  return entry;
}

async function linkLocalizations(strapi, uid, leftId, rightId) {
  const query = strapi.db.query(uid);
  await query.update({ where: { id: leftId }, data: { localizations: [rightId] } });
  await query.update({ where: { id: rightId }, data: { localizations: [leftId] } });
}

async function pruneUnexpected(strapi, uid, expectedIds) {
  const entries = await strapi.db.query(uid).findMany({});
  for (const entry of entries) {
    if (!expectedIds.has(entry.id) && ['ru', 'en'].includes(entry.locale)) {
      await strapi.entityService.delete(uid, entry.id);
    }
  }
}

async function verifyImportedCatalog(strapi, catalog, expectedProductIds, expectedDictionaryIds, publish) {
  const parquetQuery = strapi.db.query('api::parquet.parquet');
  const parquets = await parquetQuery.findMany({
    where: { id: { $in: [...expectedProductIds] } },
    populate: ['image', 'images', 'country', 'wood', 'color', 'coating', 'localizations'],
  });
  if (parquets.length !== catalog.products.length * 2) {
    throw new Error(`Expected ${catalog.products.length * 2} localized parquet rows, found ${parquets.length}`);
  }
  for (const parquet of parquets) {
    if (!parquet.image || parquet.images?.length !== 2) {
      throw new Error(`${parquet.locale}:${parquet.name} has incomplete media`);
    }
    if (!parquet.country || !parquet.wood || !parquet.color || !parquet.coating) {
      throw new Error(`${parquet.locale}:${parquet.name} has incomplete relations`);
    }
    if (parquet.localizations?.length !== 1) {
      throw new Error(`${parquet.locale}:${parquet.name} has no paired localization`);
    }
    if (publish && !parquet.publishedAt) {
      throw new Error(`${parquet.locale}:${parquet.name} is not published`);
    }
  }

  for (const [dictionaryName, ids] of Object.entries(expectedDictionaryIds)) {
    const entries = await strapi.db.query(dictionaryModels[dictionaryName]).findMany({
      where: { id: { $in: [...ids] } },
      populate: ['localizations'],
    });
    if (entries.length !== catalog.dictionaries[dictionaryName].length * 2) {
      throw new Error(`${dictionaryName} localization count is incomplete`);
    }
    if (entries.some((entry) => entry.localizations?.length !== 1)) {
      throw new Error(`${dictionaryName} contains an unpaired localization`);
    }
  }

  return {
    localizedParquets: parquets.length,
    RussianParquets: parquets.filter((entry) => entry.locale === 'ru').length,
    EnglishParquets: parquets.filter((entry) => entry.locale === 'en').length,
    mediaRows: new Set(parquets.flatMap((entry) => [entry.image.id, ...entry.images.map((image) => image.id)])).size,
  };
}

async function importCatalog(catalog, mediaDir, options) {
  const createStrapi = require('@strapi/strapi').default;
  const strapi = await createStrapi().load();

  try {
    const localeService = strapi.plugin('i18n').service('locales');
    if (!(await localeService.findByCode('en'))) {
      await localeService.create({ code: 'en', name: 'English (en)' });
    }

    const dictionaries = {};
    const expectedDictionaryIds = {};
    for (const [dictionaryName, definitions] of Object.entries(catalog.dictionaries)) {
      dictionaries[dictionaryName] = {};
      expectedDictionaryIds[dictionaryName] = new Set();
      for (const definition of definitions) {
        const pair = await ensureLocalizedPair(
          strapi,
          dictionaryModels[dictionaryName],
          definition,
          options.publish
        );
        dictionaries[dictionaryName][definition.key] = pair;
        expectedDictionaryIds[dictionaryName].add(pair.ru.id);
        expectedDictionaryIds[dictionaryName].add(pair.en.id);
      }
    }

    const uploads = {};
    const expectedProductIds = new Set();
    for (const [productIndex, product] of catalog.products.entries()) {
      process.stdout.write(`[cms ${productIndex + 1}/${catalog.products.length}] ${product.name.ru}\n`);
      if (!uploads[product.mediaKey]) {
        uploads[product.mediaKey] = [];
        for (let imageIndex = 1; imageIndex <= 3; imageIndex += 1) {
          const fileName = `nonna-parquet-${product.mediaKey}-${String(imageIndex).padStart(2, '0')}.jpg`;
          uploads[product.mediaKey].push(
            await ensureUpload(
              strapi,
              path.join(mediaDir, fileName),
              `${product.name.ru}, фото ${imageIndex}`
            )
          );
        }
      }

      const ruRelations = {
        country: dictionaries.countries[product.country].ru,
        wood: dictionaries.woods[product.wood].ru,
        color: dictionaries.colors[product.color].ru,
        coating: dictionaries.coatings[product.coating].ru,
      };
      const enRelations = {
        country: dictionaries.countries[product.country].en,
        wood: dictionaries.woods[product.wood].en,
        color: dictionaries.colors[product.color].en,
        coating: dictionaries.coatings[product.coating].en,
      };
      const ru = await ensureProductLocale(
        strapi,
        product,
        'ru',
        ruRelations,
        uploads[product.mediaKey],
        options.publish
      );
      const en = await ensureProductLocale(
        strapi,
        product,
        'en',
        enRelations,
        uploads[product.mediaKey],
        options.publish
      );
      await linkLocalizations(strapi, 'api::parquet.parquet', ru.id, en.id);
      expectedProductIds.add(ru.id);
      expectedProductIds.add(en.id);
    }

    if (options.replace) {
      await pruneUnexpected(strapi, 'api::parquet.parquet', expectedProductIds);
    }

    return await verifyImportedCatalog(
      strapi,
      catalog,
      expectedProductIds,
      expectedDictionaryIds,
      options.publish
    );
  } finally {
    await strapi.destroy();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const catalog = loadCatalog();
  const summary = validateCatalog(catalog);
  process.stdout.write(`${JSON.stringify({ catalog: summary })}\n`);

  if (options.prepareMedia) {
    const prepared = await prepareMedia(catalog, options.mediaDir);
    process.stdout.write(`${JSON.stringify({ preparedMediaGroups: prepared.length })}\n`);
  }
  if (options.import) {
    const imported = await importCatalog(catalog, options.mediaDir, options);
    process.stdout.write(`${JSON.stringify({ imported })}\n`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  publicationData,
  sortSourceImages,
  validateCatalog,
};
