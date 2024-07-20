'use strict';

/**
 * coating service
 */

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::coating.coating');
