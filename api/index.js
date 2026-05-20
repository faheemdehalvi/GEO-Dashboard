// Vercel serverless entry. Imports the Express app from server.js and exports
// it as the request handler. `vercel.json` routes /api/(.*) to this file.
module.exports = require('../server.js');
