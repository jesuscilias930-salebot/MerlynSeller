require('dotenv').config();
// Import Express.js
const express = require('express');
const webhookRoutes = require('./routes/webhook.routes');


// Create an Express app
const app = express();

// Middleware to parse JSON bodies
app.use(express.json());

// Routes
app.use('/', webhookRoutes);

// Set port
const port = process.env.PORT || 3000;

// Start the server
app.listen(port, () => {
  console.log(`\nListening on port ${port}\n`);
});
