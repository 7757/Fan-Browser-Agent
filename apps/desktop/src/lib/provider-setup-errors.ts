const PROVIDER_SETUP_ERROR_RE =
  /No inference provider(?: is)? configured|no_provider_configured|missing_api_key|set an API key|configure .*API key/i

export function isProviderSetupErrorMessage(message: null | string | undefined): boolean {
  const text = message?.trim()

  if (!text) {
    return false
  }

  return PROVIDER_SETUP_ERROR_RE.test(text)
}
