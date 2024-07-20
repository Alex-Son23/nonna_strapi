'use strict';

/**
 * parquet router
 */

const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = createCoreRouter('api::parquet.parquet');
