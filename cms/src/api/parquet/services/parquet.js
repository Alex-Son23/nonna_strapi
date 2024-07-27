'use strict';

/**
 * parquet service
 */

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::parquet.parquet');
