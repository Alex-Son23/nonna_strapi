'use strict';

/**
 * site-news service
 */

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::site-news.site-news');
