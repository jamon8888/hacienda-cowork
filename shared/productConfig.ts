import product from '../product.json';

export interface DistributionProductConfig {
  id: string;
  hostedApiBaseUrl: string;
  auth: {
    provider: 'none' | 'supabase';
    url: string;
    anonKey: string;
    storageKey: string;
  };
  telemetry: {
    sentryDsn: string;
    eventsUrl: string;
    eventsAnonKey: string;
  };
  newsletterUrl: string;
  interviewBookingUrl: string;
  billingApiBaseUrl: string;
  updates: {
    provider: 'none' | 's3';
    bucket: string;
    endpoint: string;
    path: string;
    internalPath: string;
    region: string;
    acl: '' | 'private' | 'public-read';
  };
  documentEngine: {
    releaseRepository: string;
    installDirectoryName: string;
  };
  /**
   * A vertical pack the distribution ships (docs/distributions.md). The folder
   * is relative to the packaged `resources/` directory. It adds prompt text
   * and skills; it unlocks no client feature.
   */
  verticalPack?: {
    id: string;
    resourcePath: string;
  };
}

type ProductWithDistribution = typeof product & {
  distribution: DistributionProductConfig;
};

export const distributionProductConfig = (product as ProductWithDistribution).distribution;

export function hasHostedAccountProvider(): boolean {
  const auth = distributionProductConfig.auth;
  return auth.provider !== 'none' && Boolean(auth.url && auth.anonKey);
}

export function hasHostedApi(): boolean {
  return Boolean(distributionProductConfig.hostedApiBaseUrl.trim());
}

export function hasNewsletter(): boolean {
  return Boolean(distributionProductConfig.newsletterUrl.trim());
}

export function hasUpdateFeed(): boolean {
  const updates = distributionProductConfig.updates;
  return updates.provider === 's3'
    && Boolean(updates.bucket && updates.endpoint && updates.path && updates.region);
}

/** The distribution's pack folder (relative, inside resources/), or null. */
export function getDistributionVerticalPack(): { id: string; resourcePath: string } | null {
  const pack = distributionProductConfig.verticalPack;
  if (!pack?.id || !pack.resourcePath) return null;
  // A profile is configuration, not code: refuse a path that leaves resources/.
  const segments = pack.resourcePath.replace(/\\/g, '/').split('/');
  if (pack.resourcePath.startsWith('/') || segments.includes('..')) return null;
  return { id: pack.id, resourcePath: pack.resourcePath };
}

