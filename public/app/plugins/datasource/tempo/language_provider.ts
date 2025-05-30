import { AdHocVariableFilter, LanguageProvider, SelectableValue } from '@grafana/data';
import { getTemplateSrv } from '@grafana/runtime';
import { VariableFormatID } from '@grafana/schema';

import {
  filterToQuerySection,
  getAllTags,
  getIntrinsicTags,
  getTagsByScope,
  getUnscopedTags,
} from './SearchTraceQLEditor/utils';
import { TraceqlFilter, TraceqlSearchScope } from './dataquery.gen';
import { TempoDatasource } from './datasource';
import { enumIntrinsics, intrinsicsV1 } from './traceql/traceql';
import { Scope } from './types';

// Limit maximum tags retrieved from the backend
export const TAGS_LIMIT = 5000;

// Limit maximum options in select dropdowns
export const OPTIONS_LIMIT = 1000;

export default class TempoLanguageProvider extends LanguageProvider {
  datasource: TempoDatasource;
  tagsV1?: string[];
  tagsV2?: Scope[];
  constructor(datasource: TempoDatasource, initialValues?: any) {
    super();

    this.datasource = datasource;
    Object.assign(this, initialValues);
  }

  request = async (url: string, params = {}) => {
    const res = await this.datasource.metadataRequest(url, params);
    return res?.data;
  };

  start = async () => {
    if (!this.startTask) {
      this.startTask = this.fetchTags().then(() => {
        return [];
      });
    }

    return this.startTask;
  };

  getTagsLimit = () => {
    return this.datasource.instanceSettings.jsonData?.tagLimit || TAGS_LIMIT;
  };

  async fetchTags() {
    let v1Resp, v2Resp;
    try {
      v2Resp = await this.request('/api/v2/search/tags', { limit: this.getTagsLimit() });
    } catch (error) {
      v1Resp = await this.request('/api/search/tags', []);
    }

    if (v2Resp && v2Resp.scopes) {
      this.setV2Tags(v2Resp.scopes);
    } else if (v1Resp) {
      this.setV1Tags(v1Resp.tagNames);
    }
  }

  setV1Tags = (tags: string[]) => {
    this.tagsV1 = tags;
  };

  setV2Tags = (tags: Scope[]) => {
    this.tagsV2 = tags;
  };

  getIntrinsics = () => {
    if (this.tagsV2) {
      return getIntrinsicTags(this.tagsV2);
    }
    return intrinsicsV1;
  };

  getTags = (scope?: TraceqlSearchScope) => {
    if (this.tagsV2 && scope) {
      if (scope === TraceqlSearchScope.Unscoped) {
        return getUnscopedTags(this.tagsV2);
      }
      return getTagsByScope(this.tagsV2, scope);
    } else if (this.tagsV1) {
      // This is needed because the /api/v2/search/tag/${tag}/values API expects "status" and the v1 API expects "status.code"
      // so Tempo doesn't send anything and we inject it here for the autocomplete
      if (!this.tagsV1.find((t) => t === 'status')) {
        this.tagsV1.push('status');
      }
      return this.tagsV1;
    }
    return [];
  };

  getTraceqlAutocompleteTags = (scope?: string) => {
    if (this.tagsV2) {
      if (!scope) {
        // have not typed a scope yet || unscoped (.) typed
        return getUnscopedTags(this.tagsV2);
      } else if (scope === TraceqlSearchScope.Unscoped) {
        return getUnscopedTags(this.tagsV2);
      }
      return getTagsByScope(this.tagsV2, scope);
    } else if (this.tagsV1) {
      // This is needed because the /api/v2/search/tag/${tag}/values API expects "status" and the v1 API expects "status.code"
      // so Tempo doesn't send anything and we inject it here for the autocomplete
      if (!this.tagsV1.find((t) => t === 'status')) {
        this.tagsV1.push('status');
      }
      return this.tagsV1;
    }
    return [];
  };

  getAutocompleteTags = () => {
    if (this.tagsV2) {
      return getAllTags(this.tagsV2);
    } else if (this.tagsV1) {
      // This is needed because the /api/search/tag/${tag}/values API expects "status.code" and the v2 API expects "status"
      // so Tempo doesn't send anything and we inject it here for the autocomplete
      if (!this.tagsV1.find((t) => t === 'status.code')) {
        this.tagsV1.push('status.code');
      }
      return this.tagsV1;
    }
    return [];
  };

  async getOptionsV1(tag: string): Promise<Array<SelectableValue<string>>> {
    const encodedTag = this.encodeTag(tag);
    const response = await this.request(`/api/search/tag/${encodedTag}/values`);
    let options: Array<SelectableValue<string>> = [];
    if (response && response.tagValues) {
      options = response.tagValues.map((v: string) => ({
        value: v,
        label: v,
      }));
    }
    return options;
  }

  async getOptionsV2(tag: string, query?: string): Promise<Array<SelectableValue<string>>> {
    const encodedTag = this.encodeTag(tag);
    const response = await this.request(
      `/api/v2/search/tag/${encodedTag}/values`,
      query
        ? { q: getTemplateSrv().replace(query, {}, VariableFormatID.Pipe), limit: this.getTagsLimit() }
        : { limit: this.getTagsLimit() }
    );
    let options: Array<SelectableValue<string>> = [];
    if (response && response.tagValues) {
      response.tagValues.forEach((v: { type: string; value?: string }) => {
        if (v.value) {
          options.push({
            type: v.type,
            value: v.value,
            label: v.value,
          });
        }
      });
    }
    return options;
  }

  /**
   * Encode (serialize) a given tag for use in a URL.
   *
   * @param tag the tag to encode
   * @returns the encoded tag
   */
  private encodeTag = (tag: string): string => {
    // If we call `encodeURIComponent` only once, we still get an error when issuing a request to the backend
    // Reference: https://stackoverflow.com/a/37456192
    return encodeURIComponent(encodeURIComponent(tag));
  };

  generateQueryFromFilters({
    traceqlFilters,
    adhocFilters,
  }: {
    traceqlFilters?: TraceqlFilter[];
    adhocFilters?: AdHocVariableFilter[];
  }) {
    if (!traceqlFilters && !adhocFilters) {
      return '';
    }

    const allFilters = [
      ...this.generateQueryFromTraceQlFilters(traceqlFilters || []),
      ...this.generateQueryFromAdHocFilters(adhocFilters || []),
    ];

    return `{${allFilters.join(' && ')}}`;
  }

  private generateQueryFromTraceQlFilters(filters: TraceqlFilter[]) {
    if (!filters) {
      return '';
    }

    return filters
      .filter((f) => f.tag && f.operator && f.value?.length)
      .map((f) => filterToQuerySection(f, filters, this));
  }

  private generateQueryFromAdHocFilters = (filters: AdHocVariableFilter[]) => {
    return filters
      .filter((f) => f.key && f.operator && f.value)
      .map((f) => `${f.key}${f.operator}${this.adHocValueHelper(f)}`);
  };

  adHocValueHelper = (f: AdHocVariableFilter) => {
    if (this.getIntrinsics().find((t) => t === f.key) && enumIntrinsics.includes(f.key)) {
      return f.value;
    }
    if (parseInt(f.value, 10).toString() === f.value) {
      return f.value;
    }
    return `"${f.value}"`;
  };
}
