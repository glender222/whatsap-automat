import config from '../../config/index';
import pool from '../../config/database';
import { campaignDispatcher } from '../../services/campaigns/CampaignDispatcher';

async function main() {
  const [tenantId, campaignId, graphFixture, reviewKey] = process.argv.slice(2);
  const target = new URL(graphFixture);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' ||
      config.database.host !== '127.0.0.1' || !/_smoke$/.test(config.database.name)) {
    throw new Error('Campaign child requires local Graph and smoke database fixtures.');
  }
  const fetchLocal = globalThis.fetch;
  globalThis.fetch = (input, options) => {
    const graph = new URL(String(input));
    if (graph.origin !== 'https://graph.facebook.com') throw new Error('Unexpected campaign provider.');
    return fetchLocal(`${target.origin}${graph.pathname}${graph.search}`, options);
  };
  await campaignDispatcher.executeCampaign(Number(tenantId), campaignId, undefined, reviewKey);
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
}).finally(() => pool.end());
