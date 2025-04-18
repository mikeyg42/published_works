// Imports the Google Cloud client library
const {Storage} = require('@google-cloud/storage');

// Creates a client
const storage = new Storage();

/**
 * CORS configuration for GCP bucket
 */
// The ID of your GCS bucket
const bucketName = 'resume_page';

// The origins for this CORS config to allow requests from
const origins = [
  'http://localhost:4200',
  'http://localhost:4000',
  'http://localhost:8000',
  'https://michaelglendinning.com',
  'https://www.michaelglendinning.com',
  'wss://michaelglendinning.com',
  'wss://www.michaelglendinning.com'
];

// The response headers to share across origins
const responseHeaders = [
  'Content-Type',
  'Access-Control-Allow-Origin',
  'Access-Control-Allow-Methods',
  'Access-Control-Allow-Headers'
];

// The maximum amount of time the browser can make requests before it must
// repeat preflighted requests
const maxAgeSeconds = 3600;

// The HTTP methods to allow
const methods = ["GET", "HEAD", "OPTIONS", "POST"];

async function configureBucketCors() {
  await storage.bucket(bucketName).setCorsConfiguration([
    {
      maxAgeSeconds,
      method: methods,
      origin: origins,
      responseHeader: responseHeaders,
    },
  ]);

  console.log(`Bucket ${bucketName} was updated with a CORS config
      to allow ${methods.join(', ')} requests from ${origins.join(', ')} sharing 
      ${responseHeaders.join(', ')} responses across origins`);
}

configureBucketCors().catch(console.error);