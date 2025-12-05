// ===========================================
// SPEND - Plaid Backend Server
// ===========================================
// 
// SETUP:
// 1. npm install express plaid cors dotenv
// 2. Create .env file with your Plaid credentials
// 3. Run: node server.js
// 4. Server runs on http://localhost:3001
//
// ===========================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');

const app = express();
app.use(cors());
app.use(express.json());

// ===========================================
// PLAID CONFIGURATION
// ===========================================

const PLAID_CLIENT_ID = process.env.PLAID_CLIENT_ID;
const PLAID_SECRET = process.env.PLAID_SECRET;
const PLAID_ENV = process.env.PLAID_ENV || 'sandbox';

if (!PLAID_CLIENT_ID || !PLAID_SECRET) {
  console.error('\n❌ Missing Plaid credentials!');
  console.error('Create a .env file with:');
  console.error('  PLAID_CLIENT_ID=your_client_id');
  console.error('  PLAID_SECRET=your_secret');
  console.error('  PLAID_ENV=sandbox\n');
  console.error('Get credentials at: https://dashboard.plaid.com/developers/keys\n');
  process.exit(1);
}

const config = new Configuration({
  basePath: PlaidEnvironments[PLAID_ENV],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': PLAID_CLIENT_ID,
      'PLAID-SECRET': PLAID_SECRET,
    },
  },
});

const plaidClient = new PlaidApi(config);

// Store access tokens (use a database in production!)
let accessToken = null;
let itemId = null;

// ===========================================
// API ENDPOINTS
// ===========================================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', env: PLAID_ENV });
});

// Create a Link token for Plaid Link
app.post('/api/create-link-token', async (req, res) => {
  try {
    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: 'spend-user-' + Date.now() },
      client_name: 'Spend Finance Tracker',
      products: ['transactions'],
      country_codes: ['US'],
      language: 'en',
    });
    
    console.log('✓ Link token created');
    res.json({ link_token: response.data.link_token });
  } catch (error) {
    console.error('✗ Error creating link token:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to create link token' });
  }
});

// Exchange public token for access token
app.post('/api/exchange-token', async (req, res) => {
  try {
    const { public_token } = req.body;
    
    const response = await plaidClient.itemPublicTokenExchange({
      public_token: public_token,
    });
    
    accessToken = response.data.access_token;
    itemId = response.data.item_id;
    
    console.log('✓ Account connected successfully');
    res.json({ success: true });
  } catch (error) {
    console.error('✗ Error exchanging token:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to exchange token' });
  }
});

// Get transactions
app.get('/api/transactions', async (req, res) => {
  if (!accessToken) {
    return res.status(400).json({ error: 'No account connected' });
  }
  
  try {
    const now = new Date();
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(now.getDate() - 30);
    
    const startDate = thirtyDaysAgo.toISOString().split('T')[0];
    const endDate = now.toISOString().split('T')[0];

    const response = await plaidClient.transactionsGet({
      access_token: accessToken,
      start_date: startDate,
      end_date: endDate,
      options: {
        count: 100,
        offset: 0,
      },
    });
    
    console.log('✓ Fetched ' + response.data.transactions.length + ' transactions');
    res.json({ transactions: response.data.transactions });
  } catch (error) {
    console.error('✗ Error fetching transactions:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

// Get account balances
app.get('/api/accounts', async (req, res) => {
  if (!accessToken) {
    return res.status(400).json({ error: 'No account connected' });
  }
  
  try {
    const response = await plaidClient.accountsGet({
      access_token: accessToken,
    });
    
    console.log('✓ Fetched ' + response.data.accounts.length + ' accounts');
    res.json({ accounts: response.data.accounts });
  } catch (error) {
    console.error('✗ Error fetching accounts:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch accounts' });
  }
});

// Disconnect account
app.post('/api/disconnect', async (req, res) => {
  if (!accessToken) {
    return res.status(400).json({ error: 'No account connected' });
  }
  
  try {
    await plaidClient.itemRemove({
      access_token: accessToken,
    });
    
    accessToken = null;
    itemId = null;
    
    console.log('✓ Account disconnected');
    res.json({ success: true });
  } catch (error) {
    console.error('✗ Error disconnecting:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to disconnect' });
  }
});

// ===========================================
// START SERVER
// ===========================================

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log('\n========================================');
  console.log('  SPEND Backend Server');
  console.log('========================================');
  console.log('  Status:  Running');
  console.log('  Port:    ' + PORT);
  console.log('  Plaid:   ' + PLAID_ENV + ' mode');
  console.log('========================================');
  console.log('\nEndpoints:');
  console.log('  POST /api/create-link-token');
  console.log('  POST /api/exchange-token');
  console.log('  GET  /api/transactions');
  console.log('  GET  /api/accounts');
  console.log('  POST /api/disconnect');
  console.log('\nSandbox test credentials:');
  console.log('  Username: user_good');
  console.log('  Password: pass_good');
  console.log('========================================\n');
});
