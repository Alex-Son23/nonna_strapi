'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const CATALOG_PATH = path.join(__dirname, 'content', 'projects.json');
const DEFAULT_MEDIA_DIR = '/tmp/nonna-project-media';
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg']);

const dictionaryModels = {
  propertyTypes: 'api::type-of-property.type-of-property',
  countries: 'api::country.country',
};

function loadCatalog() {
  return JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
}

function assertUnique(values, label) {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} contains duplicate values`);
  }
}

function normalizeOptional(value) {
  if (typeof value !== 'string') return value || null;
  const normalized = value.trim();
  if (!normalized || (normalized.startsWith('<') && normalized.endsWith('>'))) {
    return null;
  }
  return normalized;
}

function normalizeInstagram(value) {
  const normalized = normalizeOptional(value);
  if (!normalized) return null;

  const withoutAt = normalized.replace(/^@/, '');
  try {
    const url = new URL(withoutAt);
    if (/(^|\.)instagram\.com$/i.test(url.hostname)) {
      return url.pathname.split('/').filter(Boolean)[0] || null;
    }
  } catch (_error) {
    // A plain Instagram handle is already in the format expected by the frontend.
  }
  return withoutAt.replace(/^https?:\/\/(?:www\.)?instagram\.com\//i, '').split(/[/?#]/)[0];
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function descriptionToHtml(value) {
  const normalized = normalizeOptional(value);
  if (!normalized) return null;

  return normalized
    .split(/\n\s*\n/)
    .map((paragraph) => `<p>${escapeHtml(paragraph.trim()).replaceAll('\n', '<br>')}</p>`)
    .join('');
}

function buildDictionaryDefinitions(catalog, field) {
  const translations = new Map();
  for (const project of catalog) {
    const ru = project.ru[field];
    const en = project.en[field];
    if (translations.has(ru) && translations.get(ru) !== en) {
      throw new Error(`${field} ${ru} has conflicting English translations`);
    }
    translations.set(ru, en);
  }
  return [...translations].map(([ru, en]) => ({ ru, en }));
}

function validateCatalog(catalog) {
  if (!Array.isArray(catalog) || catalog.length === 0) {
    throw new Error('Project catalog is empty or invalid');
  }

  assertUnique(catalog.map((project) => project.folder), 'project folders');
  for (const project of catalog) {
    if (!project.folder) throw new Error('A project is missing its source folder');
    for (const locale of ['ru', 'en']) {
      const content = project[locale];
      if (!content?.name || !content.typeOfProperty || !content.country) {
        throw new Error(`${project.folder} has incomplete ${locale} content`);
      }
    }
  }

  for (const locale of ['ru', 'en']) {
    assertUnique(
      catalog.map((project) =>
        [project[locale].name, normalizeOptional(project[locale].author) || ''].join('\u0000')
      ),
      `${locale} project name and author pairs`
    );
  }

  const propertyTypes = buildDictionaryDefinitions(catalog, 'typeOfProperty');
  const countries = buildDictionaryDefinitions(catalog, 'country');
  return {
    projects: catalog.length,
    propertyTypes: propertyTypes.length,
    countries: countries.length,
  };
}

function sortImageNames(files) {
  const collator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });
  return [...files].sort((left, right) => collator.compare(left, right));
}

function selectProjectImages(files) {
  const ordered = sortImageNames(files);
  if (ordered.length === 0) throw new Error('Project has no images');
  const cover = ordered.find((file) => /обложка/i.test(file)) || ordered[0];
  return {
    cover,
    gallery: ordered.filter((file) => file !== cover),
    ordered,
  };
}

async function readProjectImages(mediaDir, folder) {
  const imagesDir = path.join(mediaDir, folder, 'images');
  let entries;
  try {
    entries = await fsp.readdir(imagesDir, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Cannot read images for ${folder}: ${error.message}`);
  }
  const files = entries
    .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => entry.name);
  return { imagesDir, ...selectProjectImages(files) };
}

async function validateMediaTree(catalog, mediaDir) {
  let images = 0;
  let oversizedImages = 0;
  for (const project of catalog) {
    const selection = await readProjectImages(mediaDir, project.folder);
    images += selection.ordered.length;
    for (const file of selection.ordered) {
      const stat = await fsp.stat(path.join(selection.imagesDir, file));
      if (stat.size === 0) throw new Error(`${project.folder}/${file} is empty`);
      if (stat.size > MAX_UPLOAD_BYTES) oversizedImages += 1;
    }
  }
  return { projects: catalog.length, images, oversizedImages };
}

function parseArgs(argv) {
  const options = {
    import: false,
    replace: false,
    publish: false,
    mediaDir: DEFAULT_MEDIA_DIR,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--import') options.import = true;
    else if (argument === '--replace') options.replace = true;
    else if (argument === '--publish') options.publish = true;
    else if (argument === '--media-dir') {
      if (!argv[index + 1]) throw new Error('--media-dir requires a path');
      options.mediaDir = path.resolve(argv[index + 1]);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function publicationData(publish, publishedAt = null) {
  return publish ? { publishedAt: publishedAt || new Date() } : {};
}

async function linkLocalizations(strapi, uid, leftId, rightId) {
  const query = strapi.db.query(uid);
  await query.update({ where: { id: leftId }, data: { localizations: [rightId] } });
  await query.update({ where: { id: rightId }, data: { localizations: [leftId] } });
}

async function ensureLocalizedPair(strapi, uid, definition, publish) {
  const query = strapi.db.query(uid);
  let ru = await query.findOne({
    where: { locale: 'ru', name: definition.ru },
    populate: ['localizations'],
  });
  if (!ru) {
    ru = await strapi.entityService.create(uid, {
      data: { locale: 'ru', name: definition.ru, ...publicationData(publish) },
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
  return { ru, en };
}

function projectMediaKey(folder) {
  return crypto.createHash('sha256').update(folder).digest('hex').slice(0, 12);
}

async function prepareUploadSource(sourcePath, outputPath) {
  const sourceStat = await fsp.stat(sourcePath);
  if (sourceStat.size <= MAX_UPLOAD_BYTES) return sourcePath;

  const sharp = require('sharp');
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  await sharp(sourcePath)
    .rotate()
    .flatten({ background: '#ffffff' })
    .resize({ width: 3200, height: 3200, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 86, chromaSubsampling: '4:2:0', mozjpeg: true })
    .toFile(outputPath);

  if ((await fsp.stat(outputPath)).size > MAX_UPLOAD_BYTES) {
    throw new Error(`${sourcePath} is still larger than 15 MiB after preparation`);
  }
  return outputPath;
}

async function ensureUpload(strapi, sourcePath, preparedPath, uploadName, alternativeText) {
  const uploadQuery = strapi.db.query('plugin::upload.file');
  const existing = await uploadQuery.findOne({ where: { name: uploadName } });
  if (existing) {
    const physicalPath = path.join(strapi.dirs.static.public, existing.url.replace(/^\//, ''));
    if (fs.existsSync(physicalPath)) return existing;
    await uploadQuery.delete({ where: { id: existing.id } });
  }

  const uploadPath = await prepareUploadSource(sourcePath, preparedPath);
  const stat = await fsp.stat(uploadPath);
  if (stat.size > MAX_UPLOAD_BYTES) throw new Error(`${uploadName} exceeds the Strapi upload limit`);
  const uploaded = await strapi.plugin('upload').service('upload').upload({
    data: {
      fileInfo: { name: uploadName, alternativeText, caption: alternativeText },
    },
    files: {
      path: uploadPath,
      name: uploadName,
      type: 'image/jpeg',
      size: stat.size,
    },
  });
  if (!uploaded[0]) throw new Error(`Strapi did not return an uploaded file for ${uploadName}`);
  return uploaded[0];
}

async function ensureProjectLocale(strapi, project, locale, relations, media, publish) {
  const uid = 'api::project.project';
  const query = strapi.db.query(uid);
  const content = project[locale];
  const author = normalizeOptional(content.author);
  const candidates = await query.findMany({
    where: { locale, name: content.name },
    populate: ['localizations'],
  });
  let entry = candidates.find((candidate) => (candidate.author || null) === author);
  const data = {
    locale,
    name: content.name,
    author,
    author_instagram: normalizeInstagram(content.authorInstagram),
    description: descriptionToHtml(content.description),
    image: media.cover.id,
    media: media.gallery.map((file) => file.id),
    video: null,
    parquet: null,
    type_of_property: relations.propertyType.id,
    country: relations.country.id,
    ...publicationData(publish, entry?.publishedAt),
  };

  if (!entry) {
    entry = await strapi.entityService.create(uid, {
      data,
      populate: ['localizations'],
    });
  } else {
    entry = await strapi.entityService.update(uid, entry.id, {
      data,
      populate: ['localizations'],
    });
  }
  return entry;
}

async function pruneUnexpectedProjects(strapi, expectedIds) {
  const uid = 'api::project.project';
  const entries = await strapi.db.query(uid).findMany({});
  for (const entry of entries) {
    if (!expectedIds.has(entry.id) && ['ru', 'en'].includes(entry.locale)) {
      await strapi.entityService.delete(uid, entry.id);
    }
  }
}

async function verifyImport(strapi, catalog, expectedIds, gallerySizes, publish) {
  const entries = await strapi.db.query('api::project.project').findMany({
    where: { id: { $in: [...expectedIds] } },
    populate: ['image', 'media', 'type_of_property', 'country', 'localizations'],
  });
  if (entries.length !== catalog.length * 2) {
    throw new Error(`Expected ${catalog.length * 2} localized project rows, found ${entries.length}`);
  }

  for (const entry of entries) {
    if (!entry.image || entry.media?.length !== gallerySizes.get(entry.id)) {
      throw new Error(`${entry.locale}:${entry.name} has incomplete media`);
    }
    if (!entry.type_of_property || !entry.country) {
      throw new Error(`${entry.locale}:${entry.name} has incomplete relations`);
    }
    if (entry.localizations?.length !== 1) {
      throw new Error(`${entry.locale}:${entry.name} has no paired localization`);
    }
    if (publish && !entry.publishedAt) {
      throw new Error(`${entry.locale}:${entry.name} is not published`);
    }
  }

  return {
    localizedProjects: entries.length,
    RussianProjects: entries.filter((entry) => entry.locale === 'ru').length,
    EnglishProjects: entries.filter((entry) => entry.locale === 'en').length,
    mediaRows: new Set(
      entries.flatMap((entry) => [entry.image.id, ...entry.media.map((image) => image.id)])
    ).size,
  };
}

async function importCatalog(catalog, mediaDir, options) {
  const createStrapi = require('@strapi/strapi').default;
  const strapi = await createStrapi().load();
  const temporaryDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nonna-project-import-'));

  try {
    const localeService = strapi.plugin('i18n').service('locales');
    if (!(await localeService.findByCode('en'))) {
      await localeService.create({ code: 'en', name: 'English (en)' });
    }

    const definitions = {
      propertyTypes: buildDictionaryDefinitions(catalog, 'typeOfProperty'),
      countries: buildDictionaryDefinitions(catalog, 'country'),
    };
    const dictionaries = {};
    for (const [dictionaryName, items] of Object.entries(definitions)) {
      dictionaries[dictionaryName] = new Map();
      for (const item of items) {
        dictionaries[dictionaryName].set(
          item.ru,
          await ensureLocalizedPair(
            strapi,
            dictionaryModels[dictionaryName],
            item,
            options.publish
          )
        );
      }
    }

    const expectedIds = new Set();
    const gallerySizes = new Map();
    for (const [projectIndex, project] of catalog.entries()) {
      process.stdout.write(`[cms ${projectIndex + 1}/${catalog.length}] ${project.ru.name}\n`);
      const selection = await readProjectImages(mediaDir, project.folder);
      const uploadedByName = new Map();
      const mediaKey = projectMediaKey(project.folder);
      for (const [imageIndex, file] of selection.ordered.entries()) {
        const uploadName = `nonna-project-${mediaKey}-${String(imageIndex + 1).padStart(2, '0')}.jpg`;
        const sourcePath = path.join(selection.imagesDir, file);
        uploadedByName.set(
          file,
          await ensureUpload(
            strapi,
            sourcePath,
            path.join(temporaryDir, uploadName),
            uploadName,
            `${project.ru.name}, фото ${imageIndex + 1}`
          )
        );
      }
      const media = {
        cover: uploadedByName.get(selection.cover),
        gallery: selection.gallery.map((file) => uploadedByName.get(file)),
      };

      const propertyType = dictionaries.propertyTypes.get(project.ru.typeOfProperty);
      const country = dictionaries.countries.get(project.ru.country);
      const ru = await ensureProjectLocale(
        strapi,
        project,
        'ru',
        { propertyType: propertyType.ru, country: country.ru },
        media,
        options.publish
      );
      const en = await ensureProjectLocale(
        strapi,
        project,
        'en',
        { propertyType: propertyType.en, country: country.en },
        media,
        options.publish
      );
      await linkLocalizations(strapi, 'api::project.project', ru.id, en.id);
      expectedIds.add(ru.id);
      expectedIds.add(en.id);
      gallerySizes.set(ru.id, media.gallery.length);
      gallerySizes.set(en.id, media.gallery.length);
    }

    if (options.replace) await pruneUnexpectedProjects(strapi, expectedIds);
    return await verifyImport(strapi, catalog, expectedIds, gallerySizes, options.publish);
  } finally {
    await fsp.rm(temporaryDir, { recursive: true, force: true });
    await strapi.destroy();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const catalog = loadCatalog();
  const catalogSummary = validateCatalog(catalog);
  const mediaSummary = await validateMediaTree(catalog, options.mediaDir);
  process.stdout.write(`${JSON.stringify({ catalog: catalogSummary, media: mediaSummary })}\n`);

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
  descriptionToHtml,
  normalizeInstagram,
  normalizeOptional,
  prepareUploadSource,
  publicationData,
  selectProjectImages,
  validateCatalog,
  validateMediaTree,
};
