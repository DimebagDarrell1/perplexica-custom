/** Safe messages shared by setup and saved search results. */
export const getJevFailureMessage = (reason?: string): string => {
  switch (reason) {
    case 'provider_key_mismatch':
      return 'Jev key is for OpenRouter. Choose OpenRouter in Settings > Search.';
    case 'http_401':
    case 'http_403':
      return 'Jev authentication failed. Check the provider and API key in Settings > Search.';
    case 'http_402':
      return 'Jev credits are unavailable. Check the provider balance or key credit limit.';
    case 'http_429':
      return 'Jev reached the provider rate limit.';
    case 'timeout':
      return 'Jev timed out.';
    case 'not_configured':
    case 'unsupported_provider':
      return 'Set up the Jev provider and API key in Settings > Search.';
    case 'invalid_response':
    case 'response_too_large':
      return 'Jev returned an unusable response.';
    default:
      return 'Jev is unavailable.';
  }
};
