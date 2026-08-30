'use strict';

async function assertPublicRoleEmpty(strapi) {
  const permissions = await strapi
    .plugin('users-permissions')
    .service('permission')
    .findPublicPermissions();

  if (permissions.length > 0) {
    const actions = permissions.map(({ action }) => action).sort().join(', ');
    throw new Error(`Public role must remain empty; remove permissions: ${actions}`);
  }
}

module.exports = { assertPublicRoleEmpty };
