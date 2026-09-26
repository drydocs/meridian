import { Redis } from '@upstash/redis';

// Initialize Upstash Redis client
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || '',
  token: process.env.UPSTASH_REDIS_REST_TOKEN || '',
});

const CACHE_TTL = 60; // 60 seconds TTL

export async function getCachedVaults(network: string): Promise<any[] | null> {
  try {
    const key = `vault-cache:${network}`;
    const cached = await redis.get(key);
    if (cached) {
      return JSON.parse(cached as string);
    }
    return null;
  } catch (error) {
    console.error('Failed to get cached vaults:', error);
    return null;
  }
}

export async function setCachedVaults(network: string, vaults: any[]): Promise<void> {
  try {
    const key = `vault-cache:${network}`;
    const json = JSON.stringify(vaults);
    await redis.setex(key, CACHE_TTL, json);
  } catch (error) {
    console.error('Failed to set cached vaults:', error);
  }
}