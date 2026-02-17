require('dotenv').config();
const express = require('express');
const IBM = require('ibm-cos-sdk');

const app = express();
const PORT = process.env.PORT || 8080;

// IBM COS Configuration
const cos = new IBM.S3({
endpoint: process.env.COS_ENDPOINT,
apiKeyId: process.env.COS_API_KEY,
serviceInstanceId: process.env.COS_INSTANCE_ID
});

const BUCKET_NAME = process.env.COS_BUCKET_NAME;
const METADATA_KEY = 'metadata.json';

// Fetch and parse metadata
async function getMetadata() {
try {
  const data = await cos.getObject({
    Bucket: BUCKET_NAME,
    Key: METADATA_KEY
  }).promise();
  return JSON.parse(data.Body.toString('utf-8'));
} catch (error) {
  console.error('Failed to fetch metadata:', error);
  throw new Error('Metadata unavailable');
}
}

// Download endpoint
app.get('/download/:assetId', async (req, res) => {
const { assetId } = req.params;
const { token } = req.query;

// Validate inputs
if (!assetId || !token) {
  return res.status(400).send('Missing asset ID or token');
}

try {
  // Get metadata
  const metadata = await getMetadata();
  const asset = metadata.assets.find(a => a.assetId === assetId);

  // Validate asset exists
  if (!asset) {
    return res.status(404).send('Asset not found');
  }

  // Validate password
  if (asset.password !== token) {
    console.log(`Failed auth attempt for asset: ${assetId}`);
    return res.status(403).send('Invalid token');
  }

  // Stream file from COS
  const fileStream = cos.getObject({
    Bucket: BUCKET_NAME,
    Key: asset.cosObjectKey
  }).createReadStream();

  // Set headers
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${asset.fileName}"`);

  // Pipe file to response
  fileStream.pipe(res);

  fileStream.on('error', (error) => {
    console.error('Stream error:', error);
    if (!res.headersSent) {
      res.status(500).send('Download failed');
    }
  });

} catch (error) {
  console.error('Download error:', error);
  res.status(500).send('Internal server error');
}
});

// Health check
app.get('/health', (req, res) => {
res.status(200).send('OK');
});

// Root endpoint
app.get('/', (req, res) => {
res.send('PORTUS Download Service - Active');
});

app.listen(PORT, () => {
console.log(`PORTUS Download Service running on port ${PORT}`);
});