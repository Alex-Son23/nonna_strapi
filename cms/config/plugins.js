module.exports = ({ env }) => ({
  // ..
 'transformer': {
    enabled: true,
    config: {
        prefix: '/api/',
        responseTransforms: {
          removeAttributesKey: true,
          removeDataKey: true,
        }
     }
  },
  upload: {
    config: {
      provider: 'local',
      providerOptions: {
        sizeLimit: 15 * 1024 * 1024,
      },
    },
  },
  // ..
});
