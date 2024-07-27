import type { Schema, Attribute } from '@strapi/strapi';

export interface ParquetCoating extends Schema.Component {
  collectionName: 'components_parquet_coatings';
  info: {
    displayName: 'coating';
    description: '';
  };
  attributes: {
    name: Attribute.String;
    new: Attribute.Component<'parquet.new'>;
  };
}

export interface ParquetColor extends Schema.Component {
  collectionName: 'components_parquet_colors';
  info: {
    displayName: 'color';
  };
  attributes: {
    name: Attribute.String;
  };
}

export interface ParquetCountry extends Schema.Component {
  collectionName: 'components_parquet_countries';
  info: {
    displayName: 'country';
  };
  attributes: {
    name: Attribute.String;
  };
}

export interface ParquetDecor extends Schema.Component {
  collectionName: 'components_parquet_decors';
  info: {
    displayName: 'decor';
  };
  attributes: {
    name: Attribute.String;
  };
}

export interface ParquetNew extends Schema.Component {
  collectionName: 'components_parquet_news';
  info: {
    displayName: 'new';
  };
  attributes: {};
}

export interface ParquetTypeOfPicture extends Schema.Component {
  collectionName: 'components_parquet_type_of_pictures';
  info: {
    displayName: 'type of picture';
  };
  attributes: {
    name: Attribute.String;
  };
}

export interface ParquetWood extends Schema.Component {
  collectionName: 'components_parquet_woods';
  info: {
    displayName: 'wood';
  };
  attributes: {
    name: Attribute.String;
  };
}

declare module '@strapi/types' {
  export module Shared {
    export interface Components {
      'parquet.coating': ParquetCoating;
      'parquet.color': ParquetColor;
      'parquet.country': ParquetCountry;
      'parquet.decor': ParquetDecor;
      'parquet.new': ParquetNew;
      'parquet.type-of-picture': ParquetTypeOfPicture;
      'parquet.wood': ParquetWood;
    }
  }
}
