const path = require('node:path');
const { tests } = require('@iobroker/testing');

// Run integration tests
// This will start an ioBroker js-controller and run the adapter in a controlled environment.
// See: https://github.com/ioBroker/testing

tests.integration(path.join(__dirname, '..'));
