'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { assertPublicRoleEmpty } = require('./assert-public-role-empty');

function fakeStrapi(permissions) {
  return {
    plugin(name) {
      assert.equal(name, 'users-permissions');
      return {
        service(serviceName) {
          assert.equal(serviceName, 'permission');
          return {
            async findPublicPermissions() {
              return permissions;
            },
          };
        },
      };
    },
  };
}

test('allows startup when the Strapi Public role has no permissions', async () => {
  await assert.doesNotReject(() => assertPublicRoleEmpty(fakeStrapi([])));
});

test('fails startup and identifies every unexpected Public permission', async () => {
  await assert.rejects(
    () => assertPublicRoleEmpty(fakeStrapi([
      { action: 'api::project.project.find' },
      { action: 'plugin::upload.content-api.upload' },
    ])),
    /Public role must remain empty.*api::project\.project\.find.*plugin::upload\.content-api\.upload/,
  );
});
