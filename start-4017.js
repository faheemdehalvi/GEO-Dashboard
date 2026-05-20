process.env.PORT = '4017';
process.env.AEO_RESULTS_FILE = require('path').join(__dirname, 'aeo-results-4017.json');
require('./server.js');
