require('dotenv').config();
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const IBM = require('ibm-cos-sdk');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// IBM COS Configuration
const cos = new IBM.S3({
endpoint: process.env.COS_ENDPOINT,
apiKeyId: process.env.COS_API_KEY,
serviceInstanceId: process.env.COS_INSTANCE_ID
});

const BUCKET_NAME = process.env.COS_BUCKET_NAME;
const METADATA_KEY = 'metadata.json';

//Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Trust Code Engine load balancer (CRITICAL FIX)
app.set('trust proxy', 1);

app.use(session({
secret: process.env.SESSION_SECRET,
resave: false,
saveUninitialized: false,
cookie: { 
  secure: true,      // Now safe because we trust proxy
  httpOnly: true,    // Security: prevent XSS attacks
  sameSite: 'lax',   // Security: CSRF protection
  maxAge: 3600000    // 1 hour (keep existing)
}
}));

// Multer configuration for file uploads
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Authentication middleware
function requireAuth(req, res, next) {
if (req.session.authenticated) {
  next();
} else {
  res.redirect('/');
}
}

// Password validation
function validatePassword(password) {
const hasUpperCase = /[A-Z]/.test(password);
const hasNumber = /[0-9]/.test(password);
const hasSpecialChar = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password);

return hasUpperCase && hasNumber && hasSpecialChar;
}

// Fetch metadata from COS
async function getMetadata() {
try {
  const data = await cos.getObject({
    Bucket: BUCKET_NAME,
    Key: METADATA_KEY
  }).promise();
  return JSON.parse(data.Body.toString('utf-8'));
} catch (error) {
  console.error('Failed to fetch metadata:', error);
  return { assets: [] };
}
}

// Update metadata in COS
async function updateMetadata(metadata) {
try {
  await cos.putObject({
    Bucket: BUCKET_NAME,
    Key: METADATA_KEY,
    Body: JSON.stringify(metadata, null, 2),
    ContentType: 'application/json'
  }).promise();
  return true;
} catch (error) {
  console.error('Failed to update metadata:', error);
  return false;
}
}

// List all files in COS bucket
async function listBucketFiles(prefix = '') {
try {
  const data = await cos.listObjectsV2({
    Bucket: BUCKET_NAME,
    Prefix: prefix
  }).promise();
  
  return data.Contents
    .filter(item => item.Key !== METADATA_KEY)
    .map(item => ({
      key: item.Key,
      size: item.Size,
      lastModified: item.LastModified
    }));
} catch (error) {
  console.error('Failed to list files:', error);
  return [];
}
}

// Routes

// Login page
app.get('/', (req, res) => {
if (req.session.authenticated) {
  return res.redirect('/dashboard');
}
res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

// Login handler
app.post('/login', (req, res) => {
const { email, password } = req.body;

if (email === process.env.ADMIN_EMAIL && password === process.env.ADMIN_PASSWORD) {
  req.session.authenticated = true;
  req.session.email = email;
  res.json({ success: true });
} else {
  res.status(401).json({ success: false, message: 'Invalid credentials' });
}
});

// Logout
app.get('/logout', (req, res) => {
req.session.destroy();
res.redirect('/');
});

// Dashboard
app.get('/dashboard', requireAuth, (req, res) => {
res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
});

// API: Get all files
app.get('/api/files', requireAuth, async (req, res) => {
try {
  const files = await listBucketFiles();
  res.json({ success: true, files });
} catch (error) {
  res.status(500).json({ success: false, message: error.message });
}
});

// API: Get all assets
app.get('/api/assets', requireAuth, async (req, res) => {
try {
  const metadata = await getMetadata();
  res.json({ success: true, assets: metadata.assets });
} catch (error) {
  res.status(500).json({ success: false, message: error.message });
}
});

// API: Upload file
app.post('/api/upload', requireAuth, upload.single('file'), async (req, res) => {
try {
  const { folderPath, password } = req.body;
  const file = req.file;

  if (!file) {
    return res.status(400).json({ success: false, message: 'No file provided' });
  }

  // Validate password
  if (!validatePassword(password)) {
    return res.status(400).json({ 
      success: false, 
      message: 'Password must contain at least one uppercase letter, one number, and one special character' 
    });
  }

  // Generate asset ID
  const fileNameWithoutExt = path.parse(file.originalname).name;
  const uuid = uuidv4();
  const assetId = `${fileNameWithoutExt}-${uuid}`;

  // Construct COS object key
  const cosObjectKey = folderPath 
    ? `${folderPath.replace(/^\/+|\/+$/g, '')}/${file.originalname}`
    : file.originalname;

  // Upload file to COS
  await cos.putObject({
    Bucket: BUCKET_NAME,
    Key: cosObjectKey,
    Body: file.buffer,
    ContentType: file.mimetype
  }).promise();

  // Update metadata
  const metadata = await getMetadata();
  const newAsset = {
    assetId: assetId,
    fileName: file.originalname,
    cosObjectKey: cosObjectKey,
    password: password,
    createdAt: new Date().toISOString(),
    createdBy: req.session.email
  };
  
  metadata.assets.push(newAsset);
  await updateMetadata(metadata);

  // Generate download URL
  const downloadUrl = `${process.env.DOWNLOAD_SERVICE_URL}/download/${assetId}?token=${password}`;

  res.json({ 
    success: true, 
    asset: newAsset,
    downloadUrl: downloadUrl
  });

} catch (error) {
  console.error('Upload error:', error);
  res.status(500).json({ success: false, message: error.message });
}
});

// API: Delete asset
app.delete('/api/assets/:assetId', requireAuth, async (req, res) => {
try {
  const { assetId } = req.params;
  
  const metadata = await getMetadata();
  const asset = metadata.assets.find(a => a.assetId === assetId);
  
  if (!asset) {
    return res.status(404).json({ success: false, message: 'Asset not found' });
  }

  // Delete file from COS
  await cos.deleteObject({
    Bucket: BUCKET_NAME,
    Key: asset.cosObjectKey
  }).promise();

  // Remove from metadata
  metadata.assets = metadata.assets.filter(a => a.assetId !== assetId);
  await updateMetadata(metadata);

  res.json({ success: true });

} catch (error) {
  console.error('Delete error:', error);
  res.status(500).json({ success: false, message: error.message });
}
});

// Health check
app.get('/health', (req, res) => {
res.status(200).send('OK');
});

app.listen(PORT, () => {
console.log(`PORTUS Admin Portal running on port ${PORT}`);
});