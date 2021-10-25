import { filter, startsWith } from 'lodash';
import UrlBuilder from './url_builder';
import ResponseParser from './response_parser';
import SupportedNamespaces from './supported_namespaces';
import TimegrainConverter from '../time_grain_converter';
import {
  AzureMonitorQuery,
  AzureDataSourceJsonData,
  AzureMonitorMetricDefinitionsResponse,
  AzureMonitorResourceGroupsResponse,
  AzureQueryType,
  DatasourceValidationResult,
} from '../types';
import { DataSourceInstanceSettings, ScopedVars, MetricFindValue } from '@grafana/data';
import { DataSourceWithBackend, getTemplateSrv } from '@grafana/runtime';

import { getTimeSrv, TimeSrv } from 'app/features/dashboard/services/TimeSrv';
import { getAuthType, getAzureCloud, getAzurePortalUrl } from '../credentials';
import { resourceTypeDisplayNames } from '../azureMetadata';
import { routeNames } from '../utils/common';

const defaultDropdownValue = 'select';

export default class AzureMonitorDatasource extends DataSourceWithBackend<AzureMonitorQuery, AzureDataSourceJsonData> {
  apiVersion = '2018-01-01';
  apiPreviewVersion = '2017-12-01-preview';
  defaultSubscriptionId?: string;
  resourcePath: string;
  azurePortalUrl: string;
  declare resourceGroup: string;
  declare resourceName: string;
  supportedMetricNamespaces: string[] = [];
  timeSrv: TimeSrv;

  constructor(private instanceSettings: DataSourceInstanceSettings<AzureDataSourceJsonData>) {
    super(instanceSettings);

    this.timeSrv = getTimeSrv();
    this.defaultSubscriptionId = instanceSettings.jsonData.subscriptionId;

    const cloud = getAzureCloud(instanceSettings);
    this.resourcePath = `${routeNames.azureMonitor}/subscriptions`;
    this.supportedMetricNamespaces = new SupportedNamespaces(cloud).get();
    this.azurePortalUrl = getAzurePortalUrl(cloud);
  }

  isConfigured(): boolean {
    // If validation didn't return any error then the data source is properly configured
    return !this.validateDatasource();
  }

  filterQuery(item: AzureMonitorQuery): boolean {
    return !!(
      item.hide !== true &&
      item.azureMonitor &&
      item.azureMonitor.resourceGroup &&
      item.azureMonitor.resourceGroup !== defaultDropdownValue &&
      item.azureMonitor.resourceName &&
      item.azureMonitor.resourceName !== defaultDropdownValue &&
      item.azureMonitor.metricDefinition &&
      item.azureMonitor.metricDefinition !== defaultDropdownValue &&
      item.azureMonitor.metricName &&
      item.azureMonitor.metricName !== defaultDropdownValue &&
      item.azureMonitor.aggregation &&
      item.azureMonitor.aggregation !== defaultDropdownValue
    );
  }

  applyTemplateVariables(target: AzureMonitorQuery, scopedVars: ScopedVars): AzureMonitorQuery {
    const item = target.azureMonitor;

    if (!item) {
      // return target;
      throw new Error('Query is not a valid Azure Monitor Metrics query');
    }

    // fix for timeGrainUnit which is a deprecated/removed field name
    if (item.timeGrain && item.timeGrainUnit && item.timeGrain !== 'auto') {
      item.timeGrain = TimegrainConverter.createISO8601Duration(item.timeGrain, item.timeGrainUnit);
    }

    const templateSrv = getTemplateSrv();

    const subscriptionId = templateSrv.replace(target.subscription || this.defaultSubscriptionId, scopedVars);
    const resourceGroup = templateSrv.replace(item.resourceGroup, scopedVars);
    const resourceName = templateSrv.replace(item.resourceName, scopedVars);
    const metricNamespace = templateSrv.replace(item.metricNamespace, scopedVars);
    const metricDefinition = templateSrv.replace(item.metricDefinition, scopedVars);
    const timeGrain = templateSrv.replace((item.timeGrain || '').toString(), scopedVars);
    const aggregation = templateSrv.replace(item.aggregation, scopedVars);
    const top = templateSrv.replace(item.top || '', scopedVars);

    const dimensionFilters = (item.dimensionFilters ?? [])
      .filter((f) => f.dimension && f.dimension !== 'None')
      .map((f) => {
        const filter = templateSrv.replace(f.filter ?? '', scopedVars);
        return {
          dimension: templateSrv.replace(f.dimension, scopedVars),
          operator: f.operator || 'eq',
          filter: filter || '*', // send * when empty
        };
      });

    return {
      refId: target.refId,
      subscription: subscriptionId,
      queryType: AzureQueryType.AzureMonitor,
      azureMonitor: {
        resourceGroup,
        resourceName,
        metricDefinition,
        timeGrain,
        allowedTimeGrainsMs: item.allowedTimeGrainsMs,
        metricName: templateSrv.replace(item.metricName, scopedVars),
        metricNamespace:
          metricNamespace && metricNamespace !== defaultDropdownValue ? metricNamespace : metricDefinition,
        aggregation: aggregation,
        dimensionFilters,
        top: top || '10',
        alias: item.alias,
      },
    };
  }

  matchesForQuery(query: string) {
    return {
      subscriptions: query.match(/^Subscriptions\(\)/i),
      resourceGroups: query.match(/^ResourceGroups\(\)/i),
      resourceGroupsWithSub: query.match(/^ResourceGroups\(([^\)]+?)(,\s?([^,]+?))?\)/i),
      metricDefinitions: query.match(/^Namespaces\(([^\)]+?)(,\s?([^,]+?))?\)/i),
      metricDefinitionsWithSub: query.match(/^Namespaces\(([^,]+?),\s?([^,]+?)\)/i),
      resourceNames: query.match(/^ResourceNames\(([^,]+?),\s?([^,]+?)\)/i),
      resourceNamesWithSub: query.match(/^ResourceNames\(([^,]+?),\s?([^,]+?),\s?(.+?)\)/i),
      metricNamespace: query.match(/^MetricNamespace\(([^,]+?),\s?([^,]+?),\s?([^,]+?)\)/i),
      metricNamespaceWithSub: query.match(/^metricnamespace\(([^,]+?),\s?([^,]+?),\s?([^,]+?),\s?([^,]+?)\)/i),
      metricNames: query.match(/^MetricNames\(([^,]+?),\s?([^,]+?),\s?([^,]+?),\s?([^,]+?)\)/i),
      metricNamesWithSub: query.match(/^MetricNames\(([^,]+?),\s?([^,]+?),\s?([^,]+?),\s?([^,]+?),\s?(.+?)\)/i),
    };
  }

  /*
    We currently support a handful of helper functions for template variables that let
    users select resources or groups of resources. This will look at a query string and determine
    if we are in fact using one of those grafana template functions. 
  */
  isGrafanaTemplateVariableFnQuery(query: string) {
    const matches: Record<string, RegExpMatchArray | null> = this.matchesForQuery(query);
    return Object.keys(matches).some((key) => !!matches[key]);
  }

  /**
   * This is named differently than DataSourceApi.metricFindQuery
   * because it's not exposed to Grafana like the main AzureMonitorDataSource.
   * And some of the azure internal data sources return null in this function, which the
   * external interface does not support
   */
  metricFindQueryInternal(query: string): Promise<MetricFindValue[]> | null {
    const matchesForQuery = this.matchesForQuery(query);

    if (matchesForQuery.subscriptions) {
      return this.getSubscriptions();
    }

    if (matchesForQuery.resourceGroups && this.defaultSubscriptionId) {
      return this.getResourceGroups(this.defaultSubscriptionId);
    }

    if (matchesForQuery.resourceGroupsWithSub) {
      return this.getResourceGroups(this.toVariable(matchesForQuery.resourceGroupsWithSub[1]));
    }

    if (matchesForQuery.metricDefinitions && this.defaultSubscriptionId) {
      if (!matchesForQuery.metricDefinitions[3]) {
        return this.getMetricDefinitions(
          this.defaultSubscriptionId,
          this.toVariable(matchesForQuery.metricDefinitions[1])
        );
      }
    }

    if (matchesForQuery.metricDefinitionsWithSub) {
      return this.getMetricDefinitions(
        this.toVariable(matchesForQuery.metricDefinitionsWithSub[1]),
        this.toVariable(matchesForQuery.metricDefinitionsWithSub[2])
      );
    }

    if (matchesForQuery.resourceNames && this.defaultSubscriptionId) {
      const resourceGroup = this.toVariable(matchesForQuery.resourceNames[1]);
      const metricDefinition = this.toVariable(matchesForQuery.resourceNames[2]);
      return this.getResourceNames(this.defaultSubscriptionId, resourceGroup, metricDefinition);
    }

    if (matchesForQuery.resourceNamesWithSub) {
      const subscription = this.toVariable(matchesForQuery.resourceNamesWithSub[1]);
      const resourceGroup = this.toVariable(matchesForQuery.resourceNamesWithSub[2]);
      const metricDefinition = this.toVariable(matchesForQuery.resourceNamesWithSub[3]);
      return this.getResourceNames(subscription, resourceGroup, metricDefinition);
    }

    if (matchesForQuery.metricNamespace && this.defaultSubscriptionId) {
      const resourceGroup = this.toVariable(matchesForQuery.metricNamespace[1]);
      const metricDefinition = this.toVariable(matchesForQuery.metricNamespace[2]);
      const resourceName = this.toVariable(matchesForQuery.metricNamespace[3]);
      return this.getMetricNamespaces(this.defaultSubscriptionId, resourceGroup, metricDefinition, resourceName);
    }

    if (matchesForQuery.metricNamespaceWithSub) {
      const subscription = this.toVariable(matchesForQuery.metricNamespaceWithSub[1]);
      const resourceGroup = this.toVariable(matchesForQuery.metricNamespaceWithSub[2]);
      const metricDefinition = this.toVariable(matchesForQuery.metricNamespaceWithSub[3]);
      const resourceName = this.toVariable(matchesForQuery.metricNamespaceWithSub[4]);
      return this.getMetricNamespaces(subscription, resourceGroup, metricDefinition, resourceName);
    }

    if (matchesForQuery.metricNames && this.defaultSubscriptionId) {
      if (matchesForQuery.metricNames[3].indexOf(',') === -1) {
        const resourceGroup = this.toVariable(matchesForQuery.metricNames[1]);
        const metricDefinition = this.toVariable(matchesForQuery.metricNames[2]);
        const resourceName = this.toVariable(matchesForQuery.metricNames[3]);
        const metricNamespace = this.toVariable(matchesForQuery.metricNames[4]);
        return this.getMetricNames(
          this.defaultSubscriptionId,
          resourceGroup,
          metricDefinition,
          resourceName,
          metricNamespace
        );
      }
    }

    if (matchesForQuery.metricNamesWithSub) {
      const subscription = this.toVariable(matchesForQuery.metricNamesWithSub[1]);
      const resourceGroup = this.toVariable(matchesForQuery.metricNamesWithSub[2]);
      const metricDefinition = this.toVariable(matchesForQuery.metricNamesWithSub[3]);
      const resourceName = this.toVariable(matchesForQuery.metricNamesWithSub[4]);
      const metricNamespace = this.toVariable(matchesForQuery.metricNamesWithSub[5]);
      return this.getMetricNames(subscription, resourceGroup, metricDefinition, resourceName, metricNamespace);
    }

    return null;
  }

  toVariable(metric: string) {
    return getTemplateSrv().replace((metric || '').trim());
  }

  async getSubscriptions(): Promise<Array<{ text: string; value: string }>> {
    if (!this.isConfigured()) {
      return [];
    }

    return this.getResource(`${this.resourcePath}?api-version=2019-03-01`).then((result: any) => {
      return ResponseParser.parseSubscriptions(result);
    });
  }

  getResourceGroups(subscriptionId: string) {
    return this.getResource(
      `${this.resourcePath}/${subscriptionId}/resourceGroups?api-version=${this.apiVersion}`
    ).then((result: AzureMonitorResourceGroupsResponse) => {
      return ResponseParser.parseResponseValues(result, 'name', 'name');
    });
  }

  getMetricDefinitions(subscriptionId: string, resourceGroup: string) {
    return this.getResource(
      `${this.resourcePath}/${subscriptionId}/resourceGroups/${resourceGroup}/resources?api-version=${this.apiVersion}`
    )
      .then((result: AzureMonitorMetricDefinitionsResponse) => {
        return ResponseParser.parseResponseValues(result, 'type', 'type');
      })
      .then((result) => {
        return filter(result, (t) => {
          for (let i = 0; i < this.supportedMetricNamespaces.length; i++) {
            if (t.value.toLowerCase() === this.supportedMetricNamespaces[i].toLowerCase()) {
              return true;
            }
          }

          return false;
        });
      })
      .then((result) => {
        let shouldHardcodeBlobStorage = false;
        for (let i = 0; i < result.length; i++) {
          if (result[i].value === 'Microsoft.Storage/storageAccounts') {
            shouldHardcodeBlobStorage = true;
            break;
          }
        }

        if (shouldHardcodeBlobStorage) {
          result.push({
            text: 'Microsoft.Storage/storageAccounts/blobServices',
            value: 'Microsoft.Storage/storageAccounts/blobServices',
          });
          result.push({
            text: 'Microsoft.Storage/storageAccounts/fileServices',
            value: 'Microsoft.Storage/storageAccounts/fileServices',
          });
          result.push({
            text: 'Microsoft.Storage/storageAccounts/tableServices',
            value: 'Microsoft.Storage/storageAccounts/tableServices',
          });
          result.push({
            text: 'Microsoft.Storage/storageAccounts/queueServices',
            value: 'Microsoft.Storage/storageAccounts/queueServices',
          });
        }

        return result.map((v) => ({
          value: v.value,
          text: resourceTypeDisplayNames[v.value.toLowerCase()] || v.value,
        }));
      });
  }

  getResourceNames(subscriptionId: string, resourceGroup: string, metricDefinition: string) {
    return this.getResource(
      `${this.resourcePath}/${subscriptionId}/resourceGroups/${resourceGroup}/resources?api-version=${this.apiVersion}`
    ).then((result: any) => {
      if (!startsWith(metricDefinition, 'Microsoft.Storage/storageAccounts/')) {
        return ResponseParser.parseResourceNames(result, metricDefinition);
      }

      const list = ResponseParser.parseResourceNames(result, 'Microsoft.Storage/storageAccounts');
      for (let i = 0; i < list.length; i++) {
        list[i].text += '/default';
        list[i].value += '/default';
      }

      return list;
    });
  }

  getMetricNamespaces(subscriptionId: string, resourceGroup: string, metricDefinition: string, resourceName: string) {
    const url = UrlBuilder.buildAzureMonitorGetMetricNamespacesUrl(
      this.resourcePath,
      subscriptionId,
      resourceGroup,
      metricDefinition,
      resourceName,
      this.apiPreviewVersion
    );

    return this.getResource(url).then((result: any) => {
      return ResponseParser.parseResponseValues(result, 'name', 'properties.metricNamespaceName');
    });
  }

  getMetricNames(
    subscriptionId: string,
    resourceGroup: string,
    metricDefinition: string,
    resourceName: string,
    metricNamespace: string
  ) {
    const url = UrlBuilder.buildAzureMonitorGetMetricNamesUrl(
      this.resourcePath,
      subscriptionId,
      resourceGroup,
      metricDefinition,
      resourceName,
      metricNamespace,
      this.apiVersion
    );

    return this.getResource(url).then((result: any) => {
      return ResponseParser.parseResponseValues(result, 'name.localizedValue', 'name.value');
    });
  }

  getMetricMetadata(
    subscriptionId: string,
    resourceGroup: string,
    metricDefinition: string,
    resourceName: string,
    metricNamespace: string,
    metricName: string
  ) {
    const url = UrlBuilder.buildAzureMonitorGetMetricNamesUrl(
      this.resourcePath,
      subscriptionId,
      resourceGroup,
      metricDefinition,
      resourceName,
      metricNamespace,
      this.apiVersion
    );

    return this.getResource(url).then((result: any) => {
      return ResponseParser.parseMetadata(result, metricName);
    });
  }

  async testDatasource(): Promise<DatasourceValidationResult> {
    const validationError = this.validateDatasource();
    if (validationError) {
      return Promise.resolve(validationError);
    }

    try {
      const url = `${this.resourcePath}?api-version=2019-03-01`;

      return await this.getResource(url).then<DatasourceValidationResult>((response: any) => {
        return {
          status: 'success',
          message: 'Successfully queried the Azure Monitor service.',
          title: 'Success',
        };
      });
    } catch (e) {
      let message = 'Azure Monitor: ';
      message += e.statusText ? e.statusText + ': ' : '';

      if (e.data && e.data.error && e.data.error.code) {
        message += e.data.error.code + '. ' + e.data.error.message;
      } else if (e.data && e.data.error) {
        message += e.data.error;
      } else if (e.data) {
        message += e.data;
      } else {
        message += 'Cannot connect to Azure Monitor REST API.';
      }
      return {
        status: 'error',
        message: message,
      };
    }
  }

  private validateDatasource(): DatasourceValidationResult | undefined {
    const authType = getAuthType(this.instanceSettings);

    if (authType === 'clientsecret') {
      if (!this.isValidConfigField(this.instanceSettings.jsonData.tenantId)) {
        return {
          status: 'error',
          message: 'The Tenant Id field is required.',
        };
      }

      if (!this.isValidConfigField(this.instanceSettings.jsonData.clientId)) {
        return {
          status: 'error',
          message: 'The Client Id field is required.',
        };
      }
    }

    return undefined;
  }

  private isValidConfigField(field?: string): boolean {
    return typeof field === 'string' && field.length > 0;
  }
}
