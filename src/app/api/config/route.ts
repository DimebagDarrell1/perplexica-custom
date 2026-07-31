import configManager from '@/lib/config';
import ModelRegistry from '@/lib/models/registry';
import { NextRequest, NextResponse } from 'next/server';
import { ConfigModelProvider } from '@/lib/config/types';
import {
  isKnownServerConfigKey,
  redactConfigSecrets,
  requireAdminToken,
} from '@/lib/config/security';

type SaveConfigBody = {
  key: string;
  value: string;
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

    configManager.updateConfig(body.key, body.value);

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
