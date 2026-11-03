/// <reference types="astro/client" />

interface NetworkInformation {
  readonly saveData?: boolean
  readonly effectiveType?: string
}

interface Navigator {
  readonly connection?: NetworkInformation
}

interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
}
