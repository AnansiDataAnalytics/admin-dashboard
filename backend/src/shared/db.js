// Single shared Mongo connection (lazy, reused across requests + domains).
// The admin tool is READ-ONLY over the dataset/ledger collections; the pipeline
// owns the writes. One client, multi-db aware (wed_v0, anansi_misc, ...).
const { MongoClient } = require('mongodb');
const { config } = require('./config');

let clientPromise = null;

function getClient() {
  if (!clientPromise) {
    if (!config.mongoUri) throw new Error('MONGODB_URI is not configured');
    const client = new MongoClient(config.mongoUri, { serverSelectionTimeoutMS: 10000 });
    clientPromise = client.connect();
  }
  return clientPromise;
}

async function getDb(name) {
  const client = await getClient();
  return client.db(name);
}

module.exports = { getClient, getDb };
