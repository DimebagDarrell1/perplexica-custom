import configManager from '@/lib/config';
import ModelRegistry from '@/lib/models/registry';
import { NextRequest, NextResponse } from 'next/server';
import { ConfigModelProvider } from '@/lib/config/types';
import {
  isKnownServerConfigKey,
  redactConfigSecrets,
  requireAdminToken,
  REDACTED_SECRET,
} from '@/lib/config/security';

type SaveConfigBody = {
  key: string;
  value: unknown;
};

export const GET = async (req: NextRequest) => {
  try {
    const unauthorized = requireAdminToken(req);
    if (unauthorized) return unauthorized;

    const fields = configManager.getUIConfigSections();
    const values = redactConfigSecrets(
      configManager.getCurrentConfig(),
      fields,
    );

    const modelRegistry = new ModelRegistry();
    const modelProviders = await modelRegistry.getActiveProviders();

    values.modelProviders = values.modelProviders.map(
      (mp: ConfigModelProvider) => {
        const activeProvider = modelProviders.find((p) => p.id === mp.id);

        return {
          ...mp,
          chatModels: activeProvider?.chatModels ?? mp.chatModels,
          embeddingModels:
            activeProvider?.embeddingModels ?? mp.embeddingModels,
        };
      },
    );

    return NextResponse.json({
      values,
      fields,
    });
  } catch (err) {
    console.error('Error in getting config: ', err);
    return Response.json(
      { message: 'An error has occurred.' },
      { status: 500 },
    );
  }
};

export const POST = async (req: NextRequest) => {
  try {
    const unauthorized = requireAdminToken(req);
    if (unauthorized) return unauthorized;

    const body: SaveConfigBody = await req.json();

    if (!body.key || body.value === undefined) {
      return Response.json(
        {
          message: 'Key and value are required.',
        },
        {
          status: 400,
        },
      );
    }

    if (
      !isKnownServerConfigKey(body.key, configManager.getUIConfigSections())
    ) {
      return Response.json(
        { message: 'Unknown or client-owned configuration key.' },
        { status: 400 },
      );
    }

    const field = configManager
      .getUIConfigSections()
      .search.find((field) => body.key === `search.${field.key}`);
    if (body.key.startsWith('search.jev')) {
      const valid =
        field?.type === 'switch'
          ? typeof body.value === 'boolean'
          : field?.type === 'select'
            ? field.options.some((option) => option.value === body.value)
            : typeof body.value === 'string' && body.value.length <= 4096;
      if (!valid)
        return Response.json(
          { message: 'Invalid Jev setting.' },
          { status: 400 },
        );
    }
    // A masked value means keep the saved credential. An empty string removes it.
    if (!(field?.type === 'password' && body.value === REDACTED_SECRET)) {
      configManager.updateConfig(body.key, body.value);
    }

    return Response.json(
      {
        message: 'Config updated successfully.',
      },
      {
        status: 200,
      },
    );
  } catch (err) {
    console.error('Error in getting config: ', err);
    return Response.json(
      { message: 'An error has occurred.' },
      { status: 500 },
    );
  }
};
