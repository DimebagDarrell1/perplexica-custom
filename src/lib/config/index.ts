import path from 'node:path';
import fs from 'fs';
import { Config, ConfigModelProvider, UIConfigSections } from './types';
import { hashObj } from '../serverUtils';
import { getModelProvidersUIConfigSection } from '../models/providers';
import { preserveRedactedSecrets } from './security';

class ConfigManager {
  configPath: string = path.join(
    process.env.DATA_DIR || process.cwd(),
    '/data/config.json',
  );
  configVersion = 1;
  currentConfig: Config = {
    version: this.configVersion,
    setupComplete: false,
    preferences: {},
    personalization: {},
    modelProviders: [],
    search: {
      searxngURL: '',
    },
  };
  uiConfigSections: UIConfigSections = {
    preferences: [
      {
        name: 'Theme',
        key: 'theme',
        type: 'select',
        options: [
          {
            name: 'Light',
            value: 'light',
          },
          {
            name: 'Dark',
            value: 'dark',
          },
        ],
        required: false,
        description: 'Choose between light and dark layouts for the app.',
        default: 'dark',
        scope: 'client',
      },
      {
        name: 'Measurement Unit',
        key: 'measureUnit',
        type: 'select',
        options: [
          {
            name: 'Imperial',
            value: 'Imperial',
          },
          {
            name: 'Metric',
            value: 'Metric',
          },
        ],
        required: false,
        description: 'Choose between Metric  and Imperial measurement unit.',
        default: 'Metric',
        scope: 'client',
      },
      {
        name: 'Auto video & image search',
        key: 'autoMediaSearch',
        type: 'switch',
        required: false,
        description: 'Automatically search for relevant images and videos.',
        default: true,
        scope: 'client',
      },
      {
        name: 'Show weather widget',
        key: 'showWeatherWidget',
        type: 'switch',
        required: false,
        description: 'Display the weather card on the home screen.',
        default: true,
        scope: 'client',
      },
      {
        name: 'Show news widget',
        key: 'showNewsWidget',
        type: 'switch',
        required: false,
        description: 'Display the recent news card on the home screen.',
        default: true,
        scope: 'client',
      },
    ],
    personalization: [
      {
        name: 'System Instructions',
        key: 'systemInstructions',
        type: 'textarea',
        required: false,
        description: 'Add custom behavior or tone for the model.',
        placeholder:
          'e.g., "Respond in a friendly and concise tone" or "Use British English and format answers as bullet points."',
        scope: 'client',
      },
    ],
    modelProviders: [],
    search: [
      {
        name: 'Enable optional Jev ranking',
        key: 'jevEnabled',
        type: 'switch',
        required: false,
        default: false,
        scope: 'server',
        description:
          'Allow the per-search Jev toggle in Balanced and Quality modes. Requests use provider API credits and send the question plus public search titles and snippets. Uploaded files stay excluded.',
      },
      {
        name: 'Jev provider',
        key: 'jevProvider',
        type: 'select',
        required: false,
        default: 'auto',
        scope: 'server',
        description:
          'Automatic recognizes OpenRouter keys; other keys use TypeSafe. You can also choose the provider explicitly.',
        options: [
          { name: 'Automatic', value: 'auto' },
          { name: 'OpenRouter', value: 'openrouter' },
          { name: 'TypeSafe', value: 'typesafe' },
        ],
      },
      {
        name: 'Jev API key',
        key: 'jevApiKey',
        type: 'password',
        required: false,
        scope: 'server',
        placeholder: 'Dedicated OpenRouter or TypeSafe key',
        description:
          'Saved on this server and masked when settings load. For OpenRouter, use a separate key with a credit limit. Clear the field to remove the saved key.',
      },
      {
        name: 'Enable Firecrawl page reading',
        key: 'firecrawlEnabled',
        type: 'switch',
        required: false,
        default: false,
        scope: 'server',
        description:
          'Read pages through your Firecrawl server in Balanced and Quality modes. It handles JavaScript-heavy pages better. Pages it cannot read fall back to the built-in reader.',
      },
      {
        name: 'Firecrawl URL',
        key: 'firecrawlApiUrl',
        type: 'string',
        required: false,
        scope: 'server',
        env: 'FIRECRAWL_API_URL',
        placeholder: 'http://your-firecrawl-host:3002',
        description:
          'Base URL of your Firecrawl API, without /v2. Prefer an address on your local network or tailnet.',
      },
      {
        name: 'Firecrawl API key',
        key: 'firecrawlApiKey',
        type: 'password',
        required: false,
        scope: 'server',
        env: 'FIRECRAWL_API_KEY',
        placeholder: 'Leave empty if your server needs no key',
        description:
          'Saved on this server and masked when settings load. Clear the field to remove the saved key.',
      },
      {
        name: 'SearXNG URL',
        key: 'searxngURL',
        type: 'string',
        required: false,
        description: 'The URL of your SearXNG instance',
        placeholder: 'http://localhost:4000',
        default: '',
        scope: 'server',
        env: 'SEARXNG_API_URL',
      },
    ],
  };

  constructor() {
    this.initialize();
  }

  private initialize() {
    this.initializeConfig();
    this.initializeFromEnv();
  }

  private saveConfig() {
    const temporaryPath = `${this.configPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(
        temporaryPath,
        JSON.stringify(this.currentConfig, null, 2),
        { mode: 0o600, flag: 'wx' },
      );
      fs.renameSync(temporaryPath, this.configPath);
    } finally {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    }
  }

  private initializeConfig() {
    if (!fs.existsSync(this.configPath)) {
      this.saveConfig();
      return;
    }
    try {
      this.currentConfig = JSON.parse(
        fs.readFileSync(this.configPath, 'utf-8'),
      );
    } catch (error) {
      // Preserve the file so a damaged configuration can be recovered.
      throw new Error(
        `Could not read settings at ${this.configPath}. The existing file was preserved.`,
        { cause: error },
      );
    }
    this.currentConfig = this.migrateConfig(this.currentConfig);
  }

  private migrateConfig(config: Config): Config {
    /* TODO: Add migrations */
    return config;
  }

  private initializeFromEnv() {
    /* providers section*/
    const providerConfigSections = getModelProvidersUIConfigSection();

    this.uiConfigSections.modelProviders = providerConfigSections;

    const newProviders: ConfigModelProvider[] = [];

    providerConfigSections.forEach((provider) => {
      const newProvider: ConfigModelProvider & { required?: string[] } = {
        id: crypto.randomUUID(),
        name: `${provider.name}`,
        type: provider.key,
        chatModels: [],
        embeddingModels: [],
        config: {},
        required: [],
        hash: '',
      };

      provider.fields.forEach((field) => {
        newProvider.config[field.key] =
          process.env[field.env!] ||
          field.default ||
          ''; /* Env var must exist for providers */

        if (field.required) newProvider.required?.push(field.key);
      });

      let configured = true;

      newProvider.required?.forEach((r) => {
        if (!newProvider.config[r]) {
          configured = false;
        }
      });

      if (configured) {
        const hash = hashObj(newProvider.config);
        newProvider.hash = hash;
        delete newProvider.required;

        const exists = this.currentConfig.modelProviders.find(
          (p) => p.hash === hash,
        );

        if (!exists) {
          newProviders.push(newProvider);
        }
      }
    });

    this.currentConfig.modelProviders.push(...newProviders);

    /* search section */
    this.uiConfigSections.search.forEach((f) => {
      if (f.env && !this.currentConfig.search[f.key]) {
        this.currentConfig.search[f.key] =
          process.env[f.env] ?? f.default ?? '';
      }
    });

    this.saveConfig();
  }

  public getConfig(key: string, defaultValue?: any): any {
    const nested = key.split('.');
    let obj: any = this.currentConfig;

    for (let i = 0; i < nested.length; i++) {
      const part = nested[i];
      if (obj == null) return defaultValue;

      obj = obj[part];
    }

    return obj === undefined ? defaultValue : obj;
  }

  public updateConfig(key: string, val: any) {
    const parts = key.split('.');
    if (parts.length === 0) return;

    let target: any = this.currentConfig;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (target[part] === null || typeof target[part] !== 'object') {
        target[part] = {};
      }

      target = target[part];
    }

    const finalKey = parts[parts.length - 1];
    target[finalKey] = val;

    this.saveConfig();
  }

  public addModelProvider(type: string, name: string, config: any) {
    const newModelProvider: ConfigModelProvider = {
      id: crypto.randomUUID(),
      name,
      type,
      config,
      chatModels: [],
      embeddingModels: [],
      hash: hashObj(config),
    };

    this.currentConfig.modelProviders.push(newModelProvider);
    this.saveConfig();

    return newModelProvider;
  }

  public removeModelProvider(id: string) {
    const index = this.currentConfig.modelProviders.findIndex(
      (p) => p.id === id,
    );

    if (index === -1) return;

    this.currentConfig.modelProviders =
      this.currentConfig.modelProviders.filter((p) => p.id !== id);

    this.saveConfig();
  }

  public async updateModelProvider(id: string, name: string, config: any) {
    const provider = this.currentConfig.modelProviders.find((p) => {
      return p.id === id;
    });

    if (!provider) throw new Error('Provider not found');

    provider.name = name;
    provider.config = preserveRedactedSecrets(provider.config, config);

    this.saveConfig();

    return provider;
  }

  public addProviderModel(
    providerId: string,
    type: 'embedding' | 'chat',
    model: any,
  ) {
    const provider = this.currentConfig.modelProviders.find(
      (p) => p.id === providerId,
    );

    if (!provider) throw new Error('Invalid provider id');

    delete model.type;

    if (type === 'chat') {
      provider.chatModels.push(model);
    } else {
      provider.embeddingModels.push(model);
    }

    this.saveConfig();

    return model;
  }

  public removeProviderModel(
    providerId: string,
    type: 'embedding' | 'chat',
    modelKey: string,
  ) {
    const provider = this.currentConfig.modelProviders.find(
      (p) => p.id === providerId,
    );

    if (!provider) throw new Error('Invalid provider id');

    if (type === 'chat') {
      provider.chatModels = provider.chatModels.filter(
        (m) => m.key !== modelKey,
      );
    } else {
      provider.embeddingModels = provider.embeddingModels.filter(
        (m) => m.key != modelKey,
      );
    }

    this.saveConfig();
  }

  public isSetupComplete() {
    return this.currentConfig.setupComplete;
  }

  public markSetupComplete() {
    if (!this.currentConfig.setupComplete) {
      this.currentConfig.setupComplete = true;
    }

    this.saveConfig();
  }

  public getUIConfigSections(): UIConfigSections {
    return this.uiConfigSections;
  }

  public getCurrentConfig(): Config {
    return JSON.parse(JSON.stringify(this.currentConfig));
  }
}

const configManager = new ConfigManager();

export default configManager;
