'use strict';

const http = require('node:http');
const { createApp } = require('./app');

const PORT = process.env.PORT || 3000;


const monitors = new Map();
const server = http.createServer(createApp(monitors));

server.listen(PORT, () => {
  console.log(`Pulse-Check API listening on http://localhost:${PORT}`);
});
