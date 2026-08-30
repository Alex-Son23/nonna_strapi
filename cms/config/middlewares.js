module.exports = [
  'strapi::logger',
  'strapi::errors',
  'strapi::security',
  {
    name: 'strapi::cors',
    config: {
      origin: (process.env.CORS_ORIGINS || 'http://localhost:3000').split(','),
    },
  },
  'strapi::poweredBy',
  'strapi::query',
  {
    name: 'strapi::body',
    config: {
      formLimit: '15mb',
      jsonLimit: '15mb',
      textLimit: '15mb',
      formidable: {
        maxFileSize: 15 * 1024 * 1024,
      },
    },
  },
  'global::validate-upload',
  'strapi::session',
  'strapi::favicon',
  'strapi::public',
];
