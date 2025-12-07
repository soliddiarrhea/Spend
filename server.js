// ===========================================
// SPEND - SimpleFIN Backend Server
// ===========================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ===========================================
// SIMPLEFIN CONFIGURATION
// ===========================================

const SIMPLEFIN_SETUP_TOKEN = process.env.SIMPLEFIN_SETUP_TOKEN;
let accessUrl = process.env.SIMPLEFIN_ACCESS_URL || null;

// ===========================================
// HELPER: Claim Setup Token to get Access URL
// ===========================================

async function claimSetupToken(setupToken) {
  try {
    // Decode the base64 setup token to get the claim URL
    const claimUrl = Buffer.from(setupToken, 'base64').toString('utf-8');
    console.log('Claiming token at:', claimUrl);
    
    // POST to claim URL to get access URL
    const response = await fetch(claimUrl, { method: 'POST' });
    
    if (!response.ok) {
      throw new Error(`Claim failed: ${response.status}`);
    }
    
    const newAccessUrl = await response.text();
    console.log('✓ Got access URL');
    return newAccessUrl;
  } catch (error) {
    console.error('✗ Error claiming token:', error.message);
    return null;
  }
}

// ===========================================
// HELPER: Fetch accounts from SimpleFIN
// ===========================================

async function fetchSimpleFINData(startDate, endDate) {
  if (!accessUrl) {
    throw new Error('No access URL configured');
  }
  
  try {
    // Parse the access URL to get credentials
    const url = new URL(accessUrl);
    const auth = Buffer.from(`${url.username}:${url.password}`).toString('base64');
    
    // Build the accounts URL
    let accountsUrl = `${url.protocol}//${url.host}${url.pathname}`;
    if (!accountsUrl.endsWith('/')) accountsUrl += '/';
    accountsUrl += 'accounts';
    
    // Add date range if provided
    if (startDate && endDate) {
      const startTimestamp = Math.floor(new Date(startDate).getTime() / 1000);
      const endTimestamp = Math.floor(new Date(endDate).getTime() / 1000);
      accountsUrl += `?start-date=${startTimestamp}&end-date=${endTimestamp}`;
    }
    
    console.log('Fetching from SimpleFIN...');
    
    const response = await fetch(accountsUrl, {
      headers: {
        'Authorization': `Basic ${auth}`
      }
    });
    
    if (!response.ok) {
      throw new Error(`SimpleFIN request failed: ${response.status}`);
    }
    
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('✗ Error fetching SimpleFIN data:', error.message);
    throw error;
  }
}

// ===========================================
// API ENDPOINTS
// ===========================================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    provider: 'simplefin',
    connected: !!accessUrl 
  });
});

// Initialize connection (claim the setup token)
app.post('/api/connect', async (req, res) => {
  try {
    const setupToken = req.body.setup_token || SIMPLEFIN_SETUP_TOKEN;
    
    if (!setupToken) {
      return res.status(400).json({ error: 'No setup token provided' });
    }
    
    const newAccessUrl = await claimSetupToken(setupToken);
    
    if (newAccessUrl) {
      accessUrl = newAccessUrl;
      console.log('✓ SimpleFIN connected');
      res.json({ success: true });
    } else {
      res.status(500).json({ error: 'Failed to claim token' });
    }
  } catch (error) {
    console.error('Connect error:', error);
    res.status(500).json({ error: 'Failed to connect' });
  }
});

// Check connection status
app.get('/api/status', (req, res) => {
  res.json({ connected: !!accessUrl });
});

// Get accounts
app.get('/api/accounts', async (req, res) => {
  // Auto-connect if we have a setup token but no access URL
  if (!accessUrl && SIMPLEFIN_SETUP_TOKEN) {
    console.log('Auto-connecting with setup token...');
    accessUrl = await claimSetupToken(SIMPLEFIN_SETUP_TOKEN);
  }
  
  if (!accessUrl) {
    return res.status(400).json({ error: 'Not connected. Call /api/connect first.' });
  }
  
  try {
    const data = await fetchSimpleFINData();
    
    // Transform to match our app's expected format
    const accounts = data.accounts.map(acc => ({
      id: acc.id,
      name: acc.name,
      mask: acc.id.slice(-4),
      balances: {
        current: acc.balance,
        available: acc.available_balance || acc.balance
      },
      type: acc.type || 'checking',
      institution: acc.org?.name || 'Unknown'
    }));
    
    console.log(`✓ Fetched ${accounts.length} accounts`);
    res.json({ accounts });
  } catch (error) {
    console.error('Accounts error:', error);
    res.status(500).json({ error: 'Failed to fetch accounts' });
  }
});

// Get transactions
app.get('/api/transactions', async (req, res) => {
  // Auto-connect if we have a setup token but no access URL
  if (!accessUrl && SIMPLEFIN_SETUP_TOKEN) {
    console.log('Auto-connecting with setup token...');
    accessUrl = await claimSetupToken(SIMPLEFIN_SETUP_TOKEN);
  }
  
  if (!accessUrl) {
    return res.status(400).json({ error: 'Not connected. Call /api/connect first.' });
  }
  
  try {
    // Get last 60 days of transactions (SimpleFIN limit)
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 60);
    
    const data = await fetchSimpleFINData(
      startDate.toISOString().split('T')[0],
      endDate.toISOString().split('T')[0]
    );
    
    // Flatten all transactions from all accounts
    let allTransactions = [];
    
    for (const account of data.accounts) {
      if (account.transactions) {
        const transactions = account.transactions.map(tx => ({
          id: tx.id,
          account_id: account.id,
          name: tx.description || tx.payee || 'Unknown',
          merchant_name: tx.payee || null,
          amount: -tx.amount, // SimpleFIN uses negative for debits, we flip it
          date: new Date(tx.posted * 1000).toISOString().split('T')[0],
          category: categorizeTransaction(tx.description || tx.payee || ''),
          pending: tx.pending || false
        }));
        allTransactions = allTransactions.concat(transactions);
      }
    }
    
    // Sort by date descending
    allTransactions.sort((a, b) => new Date(b.date) - new Date(a.date));
    
    console.log(`✓ Fetched ${allTransactions.length} transactions`);
    res.json({ transactions: allTransactions });
  } catch (error) {
    console.error('Transactions error:', error);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

// Simple categorization based on description
function categorizeTransaction(description) {
  const desc = description.toLowerCase();
  
  if (desc.match(/starbucks|coffee|mcdonald|burger|pizza|restaurant|cafe|diner|taco|subway|chipotle|wendy|chick-fil|dunkin|grubhub|doordash|uber eat|postmate/)) {
    return ['Food and Drink'];
  }
  if (desc.match(/walmart|target|amazon|costco|kroger|safeway|whole foods|trader joe|grocery|market/)) {
    return ['Shops'];
  }
  if (desc.match(/uber|lyft|gas|shell|chevron|exxon|bp|parking|transit|metro/)) {
    return ['Travel'];
  }
  if (desc.match(/netflix|spotify|hulu|disney|hbo|youtube|apple music|gaming|steam|playstation|xbox/)) {
    return ['Recreation'];
  }
  if (desc.match(/electric|water|gas|internet|phone|verizon|at&t|t-mobile|comcast|utility/)) {
    return ['Service'];
  }
  if (desc.match(/transfer|zelle|venmo|paypal|cash app/)) {
    return ['Transfer'];
  }
  if (desc.match(/payment|thank you/)) {
    return ['Payment'];
  }
  
  return ['Other'];
}

// Disconnect
app.post('/api/disconnect', (req, res) => {
  accessUrl = null;
  console.log('✓ Disconnected');
  res.json({ success: true });
});

// ===========================================
// For Plaid compatibility (legacy endpoints)
// ===========================================

app.post('/api/create-link-token', (req, res) => {
  res.json({ link_token: 'simplefin-mode' });
});

app.post('/api/exchange-token', async (req, res) => {
  if (SIMPLEFIN_SETUP_TOKEN && !accessUrl) {
    accessUrl = await claimSetupToken(SIMPLEFIN_SETUP_TOKEN);
  }
  res.json({ success: !!accessUrl });
});

// ===========================================
// START SERVER
// ===========================================

const PORT = process.env.PORT || 3001;

app.listen(PORT, async () => {
  console.log('\n========================================');
  console.log('  SPEND Backend Server (SimpleFIN)');
  console.log('========================================');
  console.log('  Status:  Running');
  console.log('  Port:    ' + PORT);
  console.log('========================================');
  
  // Auto-connect if setup token is provided
  if (SIMPLEFIN_SETUP_TOKEN && !accessUrl) {
    console.log('\nAuto-connecting to SimpleFIN...');
    accessUrl = await claimSetupToken(SIMPLEFIN_SETUP_TOKEN);
    if (accessUrl) {
      console.log('✓ Connected to SimpleFIN!\n');
    } else {
      console.log('✗ Auto-connect failed. Token may already be claimed.\n');
    }
  }
  
  console.log('Endpoints:');
  console.log('  GET  /api/health');
  console.log('  GET  /api/accounts');
  console.log('  GET  /api/transactions');
  console.log('========================================\n');
});
